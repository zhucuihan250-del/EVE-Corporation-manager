import { Router, type IRouter, type Request, type Response } from "express";
import { db, identityGroupsTable, redemptionsTable, rewardsTable, usersTable } from "@workspace/db";
import { and, count, desc, eq, getTableColumns, ne } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import {
  CreateRewardBody,
  UpdateRewardParams,
  UpdateRewardBody,
  DeleteRewardParams,
} from "@workspace/api-zod";
import { addCalendarMonths, ensureCorporationJoinedAt } from "../lib/corporation-membership";
import { rewardMemberVisibility, RewardScopeError, validateRewardGroupTarget } from "../lib/reward-access";

const router: IRouter = Router();
router.use("/rewards", requireAuth, requireTenant, requireModule("pap"));

function isValidOptionalPositiveInteger(value: number | null | undefined): boolean {
  return value === null || value === undefined || (Number.isInteger(value) && value > 0);
}

// GET /api/rewards
router.get("/rewards", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  if (req.query.view !== undefined && !["member", "manage"].includes(req.query.view as string)) {
    res.status(400).json({ error: "Invalid reward view" });
    return;
  }
  const manage = req.query.view === "manage";
  if (manage && !hasRole(tenant.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const rewards = await db.select({
    ...getTableColumns(rewardsTable),
    identityGroupName: identityGroupsTable.name,
  }).from(rewardsTable)
    .leftJoin(identityGroupsTable, and(
      eq(identityGroupsTable.id, rewardsTable.identityGroupId),
      eq(identityGroupsTable.corporationId, tenant.corporation.id),
    ))
    .where(manage
      ? eq(rewardsTable.corporationId, tenant.corporation.id)
      : rewardMemberVisibility(tenant.corporation.id, tenant.user.id, tenant.corporation.identityEnabled))
    .orderBy(desc(rewardsTable.createdAt));
  const hasTenureLimitedRewards = rewards.some((reward) => reward.eligibilityMonths !== null);
  const hasRedemptionLimitedRewards = rewards.some((reward) => reward.maxRedemptionsPerUser !== null);
  const [currentUser] = hasTenureLimitedRewards
    ? await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!))
    : [];
  const corporationJoinedAt = currentUser
    ? await ensureCorporationJoinedAt(currentUser)
    : null;
  const redemptionCounts = hasRedemptionLimitedRewards
    ? await db
      .select({ rewardId: redemptionsTable.rewardId, count: count() })
      .from(redemptionsTable)
      .where(and(
        eq(redemptionsTable.userId, req.session.userId!),
        eq(redemptionsTable.corporationId, tenant.corporation.id),
        ne(redemptionsTable.status, "cancelled"),
      ))
      .groupBy(redemptionsTable.rewardId)
    : [];
  const redemptionCountByRewardId = new Map(
    redemptionCounts.map((record) => [record.rewardId, record.count]),
  );
  const now = Date.now();

  res.json(
    rewards.map((reward) => {
      const eligibilityEndsAt = reward.eligibilityMonths !== null && corporationJoinedAt
        ? addCalendarMonths(corporationJoinedAt, reward.eligibilityMonths)
        : null;
      const userRedemptionCount = reward.maxRedemptionsPerUser === null
        ? null
        : (redemptionCountByRewardId.get(reward.id) ?? 0);
      const remainingRedemptions = reward.maxRedemptionsPerUser === null
        ? null
        : Math.max(0, reward.maxRedemptionsPerUser - (userRedemptionCount ?? 0));

      return {
        ...reward,
        userRedemptionCount,
        remainingRedemptions,
        hasReachedRedemptionLimit: remainingRedemptions === 0 && reward.maxRedemptionsPerUser !== null,
        eligibilityEndsAt,
        isEligible: reward.eligibilityMonths === null
          ? true
          : eligibilityEndsAt
            ? now <= eligibilityEndsAt.getTime()
            : null,
      };
    }),
  );
});

// POST /api/rewards - admin only
router.post("/rewards", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateRewardBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!isValidOptionalPositiveInteger(body.data.eligibilityMonths)) {
    res.status(400).json({ error: "Eligibility months must be a positive integer" });
    return;
  }
  if (!isValidOptionalPositiveInteger(body.data.maxRedemptionsPerUser)) {
    res.status(400).json({ error: "Maximum redemptions per user must be a positive integer" });
    return;
  }

  try {
    const reward = await db.transaction(async (tx) => {
      await validateRewardGroupTarget(tx, req.tenant!.corporation.id, body.data.identityGroupId, req.tenant!.corporation.identityEnabled);
      const [created] = await tx.insert(rewardsTable)
        .values({
          corporationId: req.tenant!.corporation.id,
          identityGroupId: body.data.identityGroupId ?? null,
          name: body.data.name,
          description: body.data.description ?? null,
          papCost: body.data.papCost,
          stock: body.data.stock ?? null,
          eligibilityMonths: body.data.eligibilityMonths ?? null,
          maxRedemptionsPerUser: body.data.maxRedemptionsPerUser ?? null,
          isAvailable: true,
        })
        .returning();
      return created;
    });
    res.status(201).json(reward);
  } catch (error) {
    if (error instanceof RewardScopeError) {
      res.status(400).json({ error: error.message, code: "INVALID_REWARD_GROUP" });
      return;
    }
    throw error;
  }
});

// PATCH /api/rewards/:id - admin only
router.patch("/rewards/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = UpdateRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateRewardBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!isValidOptionalPositiveInteger(body.data.eligibilityMonths)) {
    res.status(400).json({ error: "Eligibility months must be a positive integer" });
    return;
  }
  if (!isValidOptionalPositiveInteger(body.data.maxRedemptionsPerUser)) {
    res.status(400).json({ error: "Maximum redemptions per user must be a positive integer" });
    return;
  }

  const updates: Partial<typeof rewardsTable.$inferInsert> = {};
  if (body.data.identityGroupId !== undefined) updates.identityGroupId = body.data.identityGroupId;
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.description !== undefined) updates.description = body.data.description;
  if (body.data.papCost !== undefined) updates.papCost = body.data.papCost;
  if (body.data.stock !== undefined) updates.stock = body.data.stock;
  if (body.data.eligibilityMonths !== undefined) updates.eligibilityMonths = body.data.eligibilityMonths;
  if (body.data.maxRedemptionsPerUser !== undefined) updates.maxRedemptionsPerUser = body.data.maxRedemptionsPerUser;
  if (body.data.isAvailable !== undefined) updates.isAvailable = body.data.isAvailable;

  try {
    const reward = await db.transaction(async (tx) => {
      const condition = and(
        eq(rewardsTable.id, params.data.id),
        eq(rewardsTable.corporationId, req.tenant!.corporation.id),
      );
      const [current] = await tx.select().from(rewardsTable).where(condition).for("update");
      if (!current) return null;
      if (body.data.identityGroupId !== current.identityGroupId) {
        await validateRewardGroupTarget(tx, req.tenant!.corporation.id, body.data.identityGroupId, req.tenant!.corporation.identityEnabled);
      }
      if (Object.keys(updates).length === 0) return current;
      const [updated] = await tx.update(rewardsTable).set(updates).where(condition).returning();
      return updated;
    });
    if (!reward) {
      res.status(404).json({ error: "Reward not found" });
      return;
    }
    res.json(reward);
  } catch (error) {
    if (error instanceof RewardScopeError) {
      res.status(400).json({ error: error.message, code: "INVALID_REWARD_GROUP" });
      return;
    }
    throw error;
  }
});

// DELETE /api/rewards/:id - admin only
router.delete("/rewards/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = DeleteRewardParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [deletedReward] = await db
    .delete(rewardsTable)
    .where(and(
      eq(rewardsTable.id, params.data.id),
      eq(rewardsTable.corporationId, req.tenant!.corporation.id),
    ))
    .returning({ id: rewardsTable.id });

  if (!deletedReward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
