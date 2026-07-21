import { Router, type IRouter, type Request, type Response } from "express";
import { db, rewardsTable, usersTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import {
  CreateRewardBody,
  UpdateRewardParams,
  UpdateRewardBody,
  DeleteRewardParams,
} from "@workspace/api-zod";
import { addCalendarMonths, ensureCorporationJoinedAt } from "../lib/corporation-membership";

const router: IRouter = Router();

function isValidEligibilityMonths(value: number | null | undefined): boolean {
  return value === null || value === undefined || (Number.isInteger(value) && value > 0);
}

// GET /api/rewards
router.get("/rewards", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const rewards = await db.select().from(rewardsTable).orderBy(desc(rewardsTable.createdAt));
  const hasLimitedRewards = rewards.some((reward) => reward.eligibilityMonths !== null);
  const [currentUser] = hasLimitedRewards
    ? await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!))
    : [];
  const corporationJoinedAt = currentUser
    ? await ensureCorporationJoinedAt(currentUser)
    : null;
  const now = Date.now();

  res.json(
    rewards.map((reward) => {
      const eligibilityEndsAt = reward.eligibilityMonths !== null && corporationJoinedAt
        ? addCalendarMonths(corporationJoinedAt, reward.eligibilityMonths)
        : null;

      return {
        ...reward,
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
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateRewardBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  if (!isValidEligibilityMonths(body.data.eligibilityMonths)) {
    res.status(400).json({ error: "Eligibility months must be a positive integer" });
    return;
  }

  const [reward] = await db
    .insert(rewardsTable)
    .values({
      name: body.data.name,
      description: body.data.description ?? null,
      papCost: body.data.papCost,
      stock: body.data.stock ?? null,
      eligibilityMonths: body.data.eligibilityMonths ?? null,
      isAvailable: true,
    })
    .returning();

  res.status(201).json(reward);
});

// PATCH /api/rewards/:id - admin only
router.patch("/rewards/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
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
  if (!isValidEligibilityMonths(body.data.eligibilityMonths)) {
    res.status(400).json({ error: "Eligibility months must be a positive integer" });
    return;
  }

  const updates: Partial<typeof rewardsTable.$inferInsert> = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.description !== undefined) updates.description = body.data.description;
  if (body.data.papCost !== undefined) updates.papCost = body.data.papCost;
  if (body.data.stock !== undefined) updates.stock = body.data.stock;
  if (body.data.eligibilityMonths !== undefined) updates.eligibilityMonths = body.data.eligibilityMonths;
  if (body.data.isAvailable !== undefined) updates.isAvailable = body.data.isAvailable;

  const [reward] = await db
    .update(rewardsTable)
    .set(updates)
    .where(eq(rewardsTable.id, params.data.id))
    .returning();

  if (!reward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }

  res.json(reward);
});

// DELETE /api/rewards/:id - admin only
router.delete("/rewards/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
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
    .where(eq(rewardsTable.id, params.data.id))
    .returning({ id: rewardsTable.id });

  if (!deletedReward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }

  res.sendStatus(204);
});

export default router;
