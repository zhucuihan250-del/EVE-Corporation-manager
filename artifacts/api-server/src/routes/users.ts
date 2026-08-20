import { Router, type IRouter, type Request, type Response } from "express";
import { corporationMembershipsTable, db, usersTable, papRecordsTable, charactersTable, redemptionsTable, papMarketOrdersTable, papMarketTransactionsTable } from "@workspace/db";
import { and, asc, count, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import {
  UpdateUserRoleParams,
  UpdateUserRoleBody,
  AdjustUserPapParams,
  AdjustUserPapBody,
} from "@workspace/api-zod";
import { requireModule, requireTenant } from "../lib/tenant";
import { availablePap, canonicalPapBalance, normalizePap, setPapBalance } from "../lib/pap-balance";
import { writePapLedger } from "../lib/pap-ledger";

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
    pap: availablePap(u.redeemablePap, u.lockedPap),
    totalPap: u.redeemablePap,
    redeemablePap: u.redeemablePap,
    availablePap: availablePap(u.redeemablePap, u.lockedPap),
    lockedPap: u.lockedPap,
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
    pap: availablePap(row.user.redeemablePap, row.user.lockedPap),
    totalPap: row.user.redeemablePap,
    redeemablePap: row.user.redeemablePap,
    availablePap: availablePap(row.user.redeemablePap, row.user.lockedPap),
    lockedPap: row.user.lockedPap,
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
    pap: availablePap(user.redeemablePap, user.lockedPap),
    totalPap: user.redeemablePap,
    redeemablePap: user.redeemablePap,
    availablePap: availablePap(user.redeemablePap, user.lockedPap),
    lockedPap: user.lockedPap,
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
      .select({ id: usersTable.id, redeemablePap: usersTable.redeemablePap, lockedPap: usersTable.lockedPap })
      .from(usersTable)
      .where(eq(usersTable.id, targetUser.id))
      .for("update");
    if (!lockedUser) throw new Error(`PAP adjustment target ${targetUser.id} no longer exists`);

    const before = canonicalPapBalance(lockedUser.redeemablePap);
    const after = normalizePap(Math.max(lockedUser.lockedPap, before + body.data.amount));
    const appliedAmount = normalizePap(after - before);

    await tx.update(usersTable)
      .set(setPapBalance(after, lockedUser.lockedPap))
      .where(eq(usersTable.id, lockedUser.id));

    await tx.insert(papRecordsTable).values({
      corporationId: req.tenant!.corporation.id,
      userId: lockedUser.id,
      amount: appliedAmount,
      type: "adjustment",
      reason: body.data.reason,
    });
    await writePapLedger(tx, {
      corporationId: req.tenant!.corporation.id,
      userId: lockedUser.id,
      userName: targetUser.eveCharacterName ?? `User ${lockedUser.id}`,
      amount: appliedAmount,
      type: "admin_adjustment",
      balanceAfter: after,
      lockedAfter: lockedUser.lockedPap,
      adminId: req.tenant!.user.id,
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
  const [marketOrder, marketTransaction] = await Promise.all([
    db.select({ id: papMarketOrdersTable.id }).from(papMarketOrdersTable).where(and(
      eq(papMarketOrdersTable.corporationId, req.tenant!.corporation.id),
      eq(papMarketOrdersTable.ownerId, targetId),
    )).limit(1),
    db.select({ id: papMarketTransactionsTable.id }).from(papMarketTransactionsTable).where(and(
      eq(papMarketTransactionsTable.corporationId, req.tenant!.corporation.id),
      or(eq(papMarketTransactionsTable.buyerId, targetId), eq(papMarketTransactionsTable.sellerId, targetId)),
    )).limit(1),
  ]);
  if (marketOrder.length > 0 || marketTransaction.length > 0) {
    res.status(409).json({ error: "该成员存在不可删除的 PAP Market 审计记录，不能硬删除账号" });
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
