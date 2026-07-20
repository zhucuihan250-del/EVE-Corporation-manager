import { Router, type IRouter, type Request, type Response } from "express";
import { db, redemptionsTable, rewardsTable, usersTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
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
      rewardName: reward.name,
      papCost: reward.papCost,
      status: "pending",
    })
    .returning();

  res.status(201).json({
    ...redemption,
    userName: user.eveCharacterName,
  });
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
