import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, papRecordsTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import {
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  AdjustUserPapParams,
  AdjustUserPapBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// Middleware to load user for role checks
async function loadUser(req: Request & { user?: typeof usersTable.$inferSelect }, res: Response, next: () => void): Promise<void> {
  if (!req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }
  (req as Request & { user: typeof usersTable.$inferSelect }).user = user;
  next();
}

// GET /api/users - list all users (admin only)
router.get("/users", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const users = await db.select().from(usersTable).orderBy(desc(usersTable.totalPap));
  res.json(users.map(u => ({
    id: u.id,
    eveCharacterId: u.eveCharacterId,
    eveCharacterName: u.eveCharacterName,
    corporationId: u.corporationId,
    corporationName: u.corporationName,
    role: u.role,
    totalPap: u.totalPap,
    redeemablePap: u.redeemablePap,
    createdAt: u.createdAt,
  })));
});

// GET /api/users/:id
router.get("/users/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const params = UpdateUserRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    eveCharacterId: user.eveCharacterId,
    eveCharacterName: user.eveCharacterName,
    corporationId: user.corporationId,
    corporationName: user.corporationName,
    role: user.role,
    totalPap: user.totalPap,
    redeemablePap: user.redeemablePap,
    createdAt: user.createdAt,
  });
});

// PATCH /api/users/:id/role - admin only
router.patch("/users/:id/role", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = UpdateUserRoleParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateUserRoleBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [user] = await db
    .update(usersTable)
    .set({ role: body.data.role })
    .where(eq(usersTable.id, params.data.id))
    .returning();

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    eveCharacterId: user.eveCharacterId,
    eveCharacterName: user.eveCharacterName,
    corporationId: user.corporationId,
    corporationName: user.corporationName,
    role: user.role,
    totalPap: user.totalPap,
    redeemablePap: user.redeemablePap,
    createdAt: user.createdAt,
  });
});

// PATCH /api/users/:id/pap - admin manual PAP adjustment
router.patch("/users/:id/pap", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = AdjustUserPapParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = AdjustUserPapBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [targetUser] = await db.select().from(usersTable).where(eq(usersTable.id, params.data.id));
  if (!targetUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const newTotal = targetUser.totalPap + body.data.amount;
  const newRedeemable = Math.max(0, targetUser.redeemablePap + body.data.amount);

  await db.update(usersTable).set({
    totalPap: newTotal,
    redeemablePap: newRedeemable,
  }).where(eq(usersTable.id, params.data.id));

  await db.insert(papRecordsTable).values({
    userId: params.data.id,
    amount: body.data.amount,
    type: "adjustment",
    reason: body.data.reason,
  });

  res.json({ success: true, message: "PAP adjusted" });
});

export default router;
