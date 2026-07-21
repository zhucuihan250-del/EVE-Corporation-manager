import { Router, type IRouter, type Request, type Response } from "express";
import { db, redemptionsTable, rewardsTable, usersTable } from "@workspace/db";
import { and, count, desc, eq, ne, sql } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import { CreateRedemptionBody } from "@workspace/api-zod";
import { papRecordsTable } from "@workspace/db";
import { addCalendarMonths, ensureCorporationJoinedAt } from "../lib/corporation-membership";

const router: IRouter = Router();

class RedemptionRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "RedemptionRequestError";
  }
}

function formatRedemption(r: {
  id: number;
  userId: number;
  rewardId: number;
  papCost: number;
  status: string;
  createdAt: Date;
  rewardName?: string | null;
  userName?: string | null;
}) {
  return {
    id: r.id,
    userId: r.userId,
    rewardId: r.rewardId,
    papCost: r.papCost,
    status: r.status,
    rewardName: r.rewardName ?? null,
    userName: r.userName ?? null,
    createdAt: r.createdAt,
  };
}

// GET /api/redemptions - current user
router.get("/redemptions", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const records = await db
    .select({
      id: redemptionsTable.id,
      userId: redemptionsTable.userId,
      rewardId: redemptionsTable.rewardId,
      papCost: redemptionsTable.papCost,
      status: redemptionsTable.status,
      createdAt: redemptionsTable.createdAt,
      rewardName: redemptionsTable.rewardName,
      userName: usersTable.eveCharacterName,
    })
    .from(redemptionsTable)
    .leftJoin(usersTable, eq(redemptionsTable.userId, usersTable.id))
    .where(eq(redemptionsTable.userId, req.session.userId!))
    .orderBy(desc(redemptionsTable.createdAt));

  res.json(records.map(formatRedemption));
});

// POST /api/redemptions - redeem a reward
router.post("/redemptions", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const body = CreateRedemptionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [reward] = await db.select().from(rewardsTable).where(eq(rewardsTable.id, body.data.rewardId));
  if (!reward) {
    res.status(404).json({ error: "Reward not found" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  let corporationJoinedAt = user.corporationJoinedAt;
  if (reward.eligibilityMonths !== null && !corporationJoinedAt) {
    corporationJoinedAt = await ensureCorporationJoinedAt(user);
    if (!corporationJoinedAt) {
      res.status(503).json({
        error: "Unable to verify corporation join date. Please try again later.",
        code: "CORPORATION_JOIN_DATE_UNAVAILABLE",
      });
      return;
    }

  }

  try {
    const result = await db.transaction(async (tx) => {
      const [currentReward] = await tx
        .select()
        .from(rewardsTable)
        .where(eq(rewardsTable.id, reward.id))
        .for("update");
      if (!currentReward) {
        throw new RedemptionRequestError(404, "Reward not found");
      }

      const [currentUser] = await tx
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, user.id))
        .for("update");
      if (!currentUser) {
        throw new RedemptionRequestError(401, "User not found");
      }

      if (!currentReward.isAvailable) {
        throw new RedemptionRequestError(400, "Reward is not available");
      }

      if (currentReward.stock !== null && currentReward.stock <= 0) {
        throw new RedemptionRequestError(400, "Reward is out of stock");
      }

      if (currentReward.eligibilityMonths !== null) {
        const joinedAt = currentUser.corporationJoinedAt ?? corporationJoinedAt;
        if (!joinedAt) {
          throw new RedemptionRequestError(
            503,
            "Unable to verify corporation join date. Please try again later.",
            "CORPORATION_JOIN_DATE_UNAVAILABLE",
          );
        }

        const eligibilityEndsAt = addCalendarMonths(joinedAt, currentReward.eligibilityMonths);
        if (Date.now() > eligibilityEndsAt.getTime()) {
          throw new RedemptionRequestError(
            403,
            `This reward is only available within ${currentReward.eligibilityMonths} month(s) of joining the corporation.`,
            "REWARD_ELIGIBILITY_EXPIRED",
          );
        }
      }

      if (currentReward.maxRedemptionsPerUser !== null) {
        const [redemptionCount] = await tx
          .select({ count: count() })
          .from(redemptionsTable)
          .where(and(
            eq(redemptionsTable.userId, currentUser.id),
            eq(redemptionsTable.rewardId, currentReward.id),
            ne(redemptionsTable.status, "cancelled"),
          ));

        if (redemptionCount.count >= currentReward.maxRedemptionsPerUser) {
          throw new RedemptionRequestError(
            403,
            `This reward can only be redeemed ${currentReward.maxRedemptionsPerUser} time(s) per user.`,
            "REWARD_REDEMPTION_LIMIT_REACHED",
          );
        }
      }

      if (currentUser.redeemablePap < currentReward.papCost) {
        throw new RedemptionRequestError(
          400,
          `Insufficient PAP balance. Need ${currentReward.papCost}, have ${currentUser.redeemablePap}`,
        );
      }

      await tx.update(usersTable).set({
        redeemablePap: sql`redeemable_pap - ${currentReward.papCost}`,
      }).where(eq(usersTable.id, currentUser.id));

      await tx.insert(papRecordsTable).values({
        userId: currentUser.id,
        amount: -currentReward.papCost,
        type: "adjustment",
        reason: `Redeemed: ${currentReward.name}`,
      });

      if (currentReward.stock !== null) {
        await tx.update(rewardsTable).set({
          stock: sql`stock - 1`,
        }).where(eq(rewardsTable.id, currentReward.id));
      }

      const [redemption] = await tx
        .insert(redemptionsTable)
        .values({
          userId: currentUser.id,
          rewardId: currentReward.id,
          rewardName: currentReward.name,
          papCost: currentReward.papCost,
          status: "pending",
        })
        .returning();

      return {
        ...redemption,
        userName: currentUser.eveCharacterName,
      };
    });

    res.status(201).json(result);
  } catch (error) {
    if (error instanceof RedemptionRequestError) {
      res.status(error.status).json({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
      return;
    }

    throw error;
  }
});

// PATCH /api/redemptions/:id - admin only (fulfill/cancel)
router.patch("/redemptions/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const id = typeof req.params.id === "string" ? parseInt(req.params.id, 10) : NaN;
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid redemption ID" });
    return;
  }

  const { status } = req.body;
  if (!status || !["pending", "fulfilled", "cancelled"].includes(status)) {
    res.status(400).json({ error: "Invalid status" });
    return;
  }

  const [existing] = await db.select().from(redemptionsTable).where(eq(redemptionsTable.id, id));
  if (!existing) {
    res.status(404).json({ error: "Redemption not found" });
    return;
  }

  const [updated] = await db
    .update(redemptionsTable)
    .set({ status })
    .where(eq(redemptionsTable.id, id))
    .returning();

  const [member] = await db.select().from(usersTable).where(eq(usersTable.id, updated.userId));

  res.json(formatRedemption({
    ...updated,
    userName: member?.eveCharacterName ?? null,
  }));
});

// GET /api/redemptions/all - admin only
router.get("/redemptions/all", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const records = await db
    .select({
      id: redemptionsTable.id,
      userId: redemptionsTable.userId,
      rewardId: redemptionsTable.rewardId,
      papCost: redemptionsTable.papCost,
      status: redemptionsTable.status,
      createdAt: redemptionsTable.createdAt,
      rewardName: redemptionsTable.rewardName,
      userName: usersTable.eveCharacterName,
    })
    .from(redemptionsTable)
    .leftJoin(usersTable, eq(redemptionsTable.userId, usersTable.id))
    .orderBy(desc(redemptionsTable.createdAt));

  res.json(records.map(formatRedemption));
});

export default router;
