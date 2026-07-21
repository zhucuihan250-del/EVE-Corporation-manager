import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, papRecordsTable, charactersTable, redemptionsTable } from "@workspace/db";
import { asc, eq, sql } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
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

// GET /api/users - list all users (admin or above)
router.get("/users", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const users = await db
    .select()
    .from(usersTable)
    .orderBy(
      sql`NULLIF(BTRIM(${usersTable.eveCharacterName}), '') IS NULL`,
      sql`LOWER(${usersTable.eveCharacterName})`,
      asc(usersTable.id),
    );
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

// PATCH /api/users/:id/role - controller only
router.patch("/users/:id/role", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "controller")) {
    res.status(403).json({ error: "Forbidden: controller only" });
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

// PATCH /api/users/:id/pap - admin or above
router.patch("/users/:id/pap", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
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

// DELETE /api/users/:id - completely remove a user and all their data (admin or above)
router.delete("/users/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const targetId = typeof req.params.id === "string" ? parseInt(req.params.id, 10) : NaN;
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  if (targetId === req.session.userId) {
    res.status(400).json({ error: "Cannot delete your own account" });
    return;
  }

  const [target] = await db.select().from(usersTable).where(eq(usersTable.id, targetId));
  if (!target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  // Cascade delete: PAP records, redemptions, characters, then user
  // (FK cascade handles most of this, but we log what's removed)
  await db.delete(papRecordsTable).where(eq(papRecordsTable.userId, targetId));
  await db.delete(redemptionsTable).where(eq(redemptionsTable.userId, targetId));
  await db.delete(charactersTable).where(eq(charactersTable.userId, targetId));
  await db.delete(usersTable).where(eq(usersTable.id, targetId));

  req.log.info({ deletedUserId: targetId, name: target.eveCharacterName }, "Admin hard-deleted user and all their data");
  res.json({ success: true });
});

export default router;
