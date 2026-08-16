import { Router, type IRouter, type Request, type Response } from "express";
import { corporationMembershipsTable, db, usersTable, papRecordsTable, charactersTable, redemptionsTable } from "@workspace/db";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import {
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  AdjustUserPapParams,
  AdjustUserPapBody,
} from "@workspace/api-zod";
import { requireModule, requireTenant } from "../lib/tenant";
import { canonicalPapBalance, normalizePap, setPapBalance } from "../lib/pap-balance";

const router: IRouter = Router();
router.use("/users", requireAuth, requireTenant, requireModule("pap"));

async function corporationIdentities(userIds: number[], corporationId: number) {
  if (userIds.length === 0) return new Map<number, typeof charactersTable.$inferSelect>();
  const rows = await db.select().from(charactersTable).where(and(
    inArray(charactersTable.userId, userIds),
    eq(charactersTable.corporationId, corporationId),
    isNull(charactersTable.deletedAt),
  )).orderBy(asc(charactersTable.createdAt), asc(charactersTable.id));
  const result = new Map<number, typeof charactersTable.$inferSelect>();
  for (const character of rows) {
    if (character.userId && !result.has(character.userId)) result.set(character.userId, character);
  }
  return result;
}

// GET /api/users - list all users (admin or above)
router.get("/users", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const users = await db
    .select({ user: usersTable, membershipRole: corporationMembershipsTable.role })
    .from(corporationMembershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, corporationMembershipsTable.userId))
    .where(eq(corporationMembershipsTable.corporationId, req.tenant!.corporation.id))
    .orderBy(
      sql`NULLIF(BTRIM(${usersTable.eveCharacterName}), '') IS NULL`,
      sql`LOWER(${usersTable.eveCharacterName})`,
      asc(usersTable.id),
    );
  const identities = await corporationIdentities(users.map(({ user }) => user.id), req.tenant!.corporation.id);
  res.json(users.map(({ user: u, membershipRole }) => ({
    id: u.id,
    eveCharacterId: identities.get(u.id)?.eveCharacterId ?? null,
    eveCharacterName: identities.get(u.id)?.eveCharacterName ?? null,
    corporationId: req.tenant!.corporation.id,
    corporationName: req.tenant!.corporation.name,
    role: membershipRole,
    pap: u.redeemablePap,
    totalPap: u.redeemablePap,
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

  const [row] = await db.select({ user: usersTable, role: corporationMembershipsTable.role })
    .from(corporationMembershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, corporationMembershipsTable.userId))
    .where(and(
      eq(corporationMembershipsTable.corporationId, req.tenant!.corporation.id),
      eq(corporationMembershipsTable.userId, params.data.id),
    ));
  if (!row) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const identity = (await corporationIdentities([row.user.id], req.tenant!.corporation.id)).get(row.user.id);

  res.json({
    id: row.user.id,
    eveCharacterId: identity?.eveCharacterId ?? null,
    eveCharacterName: identity?.eveCharacterName ?? null,
    corporationId: req.tenant!.corporation.id,
    corporationName: req.tenant!.corporation.name,
    role: row.role,
    pap: row.user.redeemablePap,
    totalPap: row.user.redeemablePap,
    redeemablePap: row.user.redeemablePap,
    createdAt: row.user.createdAt,
  });
});

// PATCH /api/users/:id/role - controller only
router.patch("/users/:id/role", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "controller")) {
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

  const [membership] = await db.update(corporationMembershipsTable)
    .set({ role: body.data.role })
    .where(and(
      eq(corporationMembershipsTable.corporationId, req.tenant!.corporation.id),
      eq(corporationMembershipsTable.userId, params.data.id),
    )).returning();
  const [user] = membership
    ? await db.select().from(usersTable).where(eq(usersTable.id, params.data.id))
    : [];
  if (user?.corporationId === req.tenant!.corporation.id) {
    await db.update(usersTable).set({ role: body.data.role }).where(eq(usersTable.id, user.id));
  }

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const identity = (await corporationIdentities([user.id], req.tenant!.corporation.id)).get(user.id);

  res.json({
    id: user.id,
    eveCharacterId: identity?.eveCharacterId ?? null,
    eveCharacterName: identity?.eveCharacterName ?? null,
    corporationId: req.tenant!.corporation.id,
    corporationName: req.tenant!.corporation.name,
    role: membership.role,
    pap: user.redeemablePap,
    totalPap: user.redeemablePap,
    redeemablePap: user.redeemablePap,
    createdAt: user.createdAt,
  });
});

// PATCH /api/users/:id/pap - admin or above
router.patch("/users/:id/pap", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
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

  const [targetMembership] = await db.select().from(corporationMembershipsTable).where(and(
    eq(corporationMembershipsTable.corporationId, req.tenant!.corporation.id),
    eq(corporationMembershipsTable.userId, params.data.id),
  ));
  const [targetUser] = targetMembership
    ? await db.select().from(usersTable).where(eq(usersTable.id, params.data.id))
    : [];
  if (!targetMembership || !targetUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  await db.transaction(async (tx) => {
    const [lockedUser] = await tx
      .select({ id: usersTable.id, redeemablePap: usersTable.redeemablePap })
      .from(usersTable)
      .where(eq(usersTable.id, targetUser.id))
      .for("update");
    if (!lockedUser) throw new Error(`PAP adjustment target ${targetUser.id} no longer exists`);

    const before = canonicalPapBalance(lockedUser.redeemablePap);
    const after = canonicalPapBalance(before + body.data.amount);
    const appliedAmount = normalizePap(after - before);

    await tx.update(usersTable)
      .set(setPapBalance(after))
      .where(eq(usersTable.id, lockedUser.id));

    await tx.insert(papRecordsTable).values({
      corporationId: req.tenant!.corporation.id,
      userId: lockedUser.id,
      amount: appliedAmount,
      type: "adjustment",
      reason: body.data.reason,
    });
  });

  res.json({ success: true, message: "PAP adjusted" });
});

// DELETE /api/users/:id - completely remove a user and all their data (admin or above)
router.delete("/users/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
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

  const [targetMembership] = await db.select().from(corporationMembershipsTable).where(and(
    eq(corporationMembershipsTable.corporationId, req.tenant!.corporation.id),
    eq(corporationMembershipsTable.userId, targetId),
  ));
  const [target] = targetMembership ? await db.select().from(usersTable).where(eq(usersTable.id, targetId)) : [];
  if (!targetMembership || !target) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [{ membershipCount }] = await db.select({ membershipCount: count() })
    .from(corporationMembershipsTable)
    .where(eq(corporationMembershipsTable.userId, targetId));
  if (membershipCount > 1) {
    res.status(409).json({ error: "该账号属于多个军团，不能由单个军团删除整个账号" });
    return;
  }
  const identity = (await corporationIdentities([targetId], req.tenant!.corporation.id)).get(targetId);

  // Cascade delete: PAP records, redemptions, characters, then user
  // (FK cascade handles most of this, but we log what's removed)
  await db.delete(papRecordsTable).where(and(eq(papRecordsTable.userId, targetId), eq(papRecordsTable.corporationId, req.tenant!.corporation.id)));
  await db.delete(redemptionsTable).where(and(eq(redemptionsTable.userId, targetId), eq(redemptionsTable.corporationId, req.tenant!.corporation.id)));
  await db.delete(charactersTable).where(eq(charactersTable.userId, targetId));
  await db.delete(usersTable).where(eq(usersTable.id, targetId));

  req.log.info({ deletedUserId: targetId, name: identity?.eveCharacterName ?? null }, "Admin hard-deleted user and all their data");
  res.json({ success: true });
});

export default router;
