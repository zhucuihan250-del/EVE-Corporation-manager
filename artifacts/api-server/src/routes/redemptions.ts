import { Router, type IRouter, type Request, type Response } from "express";
import { db, redemptionsTable, rewardsTable, usersTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import { CreateRedemptionBody } from "@workspace/api-zod";
import { papRecordsTable } from "@workspace/db";

const router: IRouter = Router();

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
      rewardName: rewardsTable.name,
      userName: usersTable.eveCharacterName,
    })
    .from(redemptionsTable)
    .leftJoin(rewardsTable, eq(redemptionsTable.rewardId, rewardsTable.id))
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

  if (!reward.isAvailable) {
    res.status(400).json({ error: "Reward is not available" });
    return;
  }

  if (reward.stock !== null && reward.stock <= 0) {
    res.status(400).json({ error: "Reward is out of stock" });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  if (user.redeemablePap < reward.papCost) {
    res.status(400).json({ error: `Insufficient PAP balance. Need ${reward.papCost}, have ${user.redeemablePap}` });
    return;
  }

  // Deduct PAP
  await db.update(usersTable).set({
    redeemablePap: sql`redeemable_pap - ${reward.papCost}`,
  }).where(eq(usersTable.id, user.id));

  // Create PAP deduction record
  await db.insert(papRecordsTable).values({
    userId: user.id,
    amount: -reward.papCost,
    type: "adjustment",
    reason: `Redeemed: ${reward.name}`,
  });

  // Decrement stock if tracked
  if (reward.stock !== null) {
    await db.update(rewardsTable).set({
      stock: sql`stock - 1`,
    }).where(eq(rewardsTable.id, reward.id));
  }

  const [redemption] = await db
    .insert(redemptionsTable)
    .values({
      userId: user.id,
      rewardId: reward.id,
      papCost: reward.papCost,
      status: "pending",
    })
    .returning();

  res.status(201).json({
    ...redemption,
    rewardName: reward.name,
    userName: user.eveCharacterName,
  });
});

// GET /api/redemptions/all - admin only
router.get("/redemptions/all", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
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
      rewardName: rewardsTable.name,
      userName: usersTable.eveCharacterName,
    })
    .from(redemptionsTable)
    .leftJoin(rewardsTable, eq(redemptionsTable.rewardId, rewardsTable.id))
    .leftJoin(usersTable, eq(redemptionsTable.userId, usersTable.id))
    .orderBy(desc(redemptionsTable.createdAt));

  res.json(records.map(formatRedemption));
});

export default router;
