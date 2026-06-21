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

const router: IRouter = Router();

// GET /api/rewards
router.get("/rewards", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const rewards = await db.select().from(rewardsTable).orderBy(desc(rewardsTable.createdAt));
  res.json(rewards);
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

  const [reward] = await db
    .insert(rewardsTable)
    .values({
      name: body.data.name,
      description: body.data.description ?? null,
      papCost: body.data.papCost,
      stock: body.data.stock ?? null,
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

  const updates: Partial<typeof rewardsTable.$inferInsert> = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.description !== undefined) updates.description = body.data.description;
  if (body.data.papCost !== undefined) updates.papCost = body.data.papCost;
  if (body.data.stock !== undefined) updates.stock = body.data.stock;
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

  await db.delete(rewardsTable).where(eq(rewardsTable.id, params.data.id));
  res.sendStatus(204);
});

export default router;
