import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  fleetsTable,
  identityGroupMembershipsTable,
  identityGroupsTable,
  papRecordsTable,
  reimbursementClaimsTable,
} from "@workspace/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();

router.use("/tactical-groups", requireAuth, requireTenant, requireModule("identity"));

function canManageReimbursements(req: Request): boolean {
  return Boolean(
    req.tenant
    && (hasPermission(req.tenant, "reimbursement.manage")
      || hasRole(req.tenant.membership.role, "admin")),
  );
}

async function getGroupAccess(req: Request, groupId: number) {
  if (!Number.isInteger(groupId) || groupId <= 0) return null;
  const corporationId = req.tenant!.corporation.id;
  const [group, membership] = await Promise.all([
    db.select().from(identityGroupsTable).where(and(
      eq(identityGroupsTable.id, groupId),
      eq(identityGroupsTable.corporationId, corporationId),
      eq(identityGroupsTable.category, "combat"),
      eq(identityGroupsTable.isActive, true),
    )).then((rows) => rows[0] ?? null),
    db.select().from(identityGroupMembershipsTable).where(and(
      eq(identityGroupMembershipsTable.corporationId, corporationId),
      eq(identityGroupMembershipsTable.groupId, groupId),
      eq(identityGroupMembershipsTable.userId, req.tenant!.user.id),
    )).then((rows) => rows[0] ?? null),
  ]);
  if (!group) return null;
  const elevated = canManageReimbursements(req)
    || hasPermission(req.tenant!, "identity.manage")
    || hasRole(req.tenant!.membership.role, "admin");
  return membership || elevated ? { group, membership } : false;
}

function requireTacticalReimbursement(req: Request, res: Response): boolean {
  if (!req.tenant!.corporation.reimbursementEnabled) {
    res.status(403).json({ error: "Reimbursement module is not enabled for this corporation" });
    return false;
  }
  if (!req.tenant!.corporation.reimbursementOpen) {
    res.status(423).json({
      error: "本军团补损窗口已关闭",
      code: "REIMBURSEMENT_WINDOW_CLOSED",
    });
    return false;
  }
  return true;
}

router.get("/tactical-groups/:id", async (req: Request, res: Response): Promise<void> => {
  const groupId = Number(req.params.id);
  const access = await getGroupAccess(req, groupId);
  if (access === null) {
    res.status(404).json({ error: "Tactical identity group not found" });
    return;
  }
  if (access === false) {
    res.status(403).json({ error: "You are not a member of this tactical identity group" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const userId = req.tenant!.user.id;
  const [recentFleets, memberTotals, fleetTotals, myActivity, claimTotals] = await Promise.all([
    db.select({
      id: fleetsTable.id,
      corporationId: fleetsTable.corporationId,
      eveFleetId: fleetsTable.eveFleetId,
      name: fleetsTable.name,
      fleetCommander: fleetsTable.fleetCommander,
      papValue: fleetsTable.papValue,
      isActive: fleetsTable.isActive,
      fleetFunction: fleetsTable.fleetFunction,
      identityGroupId: fleetsTable.identityGroupId,
      identityGroupName: sql<string>`${access.group.name}::text`,
      reimbursementEnabled: fleetsTable.reimbursementEnabled,
      reimbursementRule: fleetsTable.reimbursementRule,
      startedAt: fleetsTable.startedAt,
      endedAt: fleetsTable.endedAt,
      createdAt: fleetsTable.createdAt,
      participantCount: sql<number>`(
        SELECT COUNT(*)::int FROM "pap_records"
        WHERE "pap_records"."fleet_id" = "fleets"."id"
          AND "pap_records"."type" = 'fleet'
      )`,
      battleReportId: sql<number | null>`(
        SELECT "battle_reports"."id" FROM "battle_reports"
        WHERE "battle_reports"."fleet_id" = "fleets"."id"
        LIMIT 1
      )`,
    }).from(fleetsTable).where(and(
      eq(fleetsTable.corporationId, corporationId),
      eq(fleetsTable.identityGroupId, groupId),
    )).orderBy(desc(fleetsTable.createdAt)).limit(10),
    db.select({ count: sql<number>`COUNT(*)::int` })
      .from(identityGroupMembershipsTable)
      .where(and(
        eq(identityGroupMembershipsTable.corporationId, corporationId),
        eq(identityGroupMembershipsTable.groupId, groupId),
      )).then((rows) => rows[0]),
    db.select({
      total: sql<number>`COUNT(*)::int`,
      active: sql<number>`COUNT(*) FILTER (WHERE ${fleetsTable.isActive} = true)::int`,
    }).from(fleetsTable).where(and(
      eq(fleetsTable.corporationId, corporationId),
      eq(fleetsTable.identityGroupId, groupId),
    )).then((rows) => rows[0]),
    db.select({
      fleetCount: sql<number>`COUNT(DISTINCT ${papRecordsTable.fleetId})::int`,
      pap: sql<number>`COALESCE(SUM(${papRecordsTable.amount}), 0)::float8`,
    }).from(papRecordsTable).innerJoin(fleetsTable, and(
      eq(fleetsTable.id, papRecordsTable.fleetId),
      eq(fleetsTable.corporationId, corporationId),
      eq(fleetsTable.identityGroupId, groupId),
    )).where(and(
      eq(papRecordsTable.corporationId, corporationId),
      eq(papRecordsTable.userId, userId),
      eq(papRecordsTable.type, "fleet"),
    )).then((rows) => rows[0]),
    db.select({
      open: sql<number>`COUNT(*) FILTER (WHERE ${reimbursementClaimsTable.status} NOT IN ('rejected', 'paid'))::int`,
      paid: sql<number>`COUNT(*) FILTER (WHERE ${reimbursementClaimsTable.status} = 'paid')::int`,
    }).from(reimbursementClaimsTable).where(and(
      eq(reimbursementClaimsTable.corporationId, corporationId),
      eq(reimbursementClaimsTable.identityGroupId, groupId),
    )).then((rows) => rows[0]),
  ]);

  res.json({
    group: {
      id: access.group.id,
      name: access.group.name,
      description: access.group.description,
      joinedAt: access.membership?.createdAt ?? null,
    },
    canManageReimbursements: canManageReimbursements(req),
    memberCount: Number(memberTotals?.count ?? 0),
    activeFleetCount: Number(fleetTotals?.active ?? 0),
    totalFleetCount: Number(fleetTotals?.total ?? 0),
    myFleetCount: Number(myActivity?.fleetCount ?? 0),
    myPap: Number(myActivity?.pap ?? 0),
    openClaimCount: Number(claimTotals?.open ?? 0),
    paidClaimCount: Number(claimTotals?.paid ?? 0),
    recentFleets,
  });
});

router.get("/tactical-groups/:id/reimbursements", async (req: Request, res: Response): Promise<void> => {
  if (!requireTacticalReimbursement(req, res)) return;
  const groupId = Number(req.params.id);
  const access = await getGroupAccess(req, groupId);
  if (access === null) {
    res.status(404).json({ error: "Tactical identity group not found" });
    return;
  }
  if (access === false) {
    res.status(403).json({ error: "You are not a member of this tactical identity group" });
    return;
  }
  const manager = canManageReimbursements(req);
  const rows = await db.select().from(reimbursementClaimsTable).where(and(
    eq(reimbursementClaimsTable.corporationId, req.tenant!.corporation.id),
    eq(reimbursementClaimsTable.identityGroupId, groupId),
    ...(manager ? [] : [eq(reimbursementClaimsTable.submittedBy, req.tenant!.user.id)]),
  )).orderBy(desc(reimbursementClaimsTable.createdAt));
  res.json(rows.map((row) => ({ ...row, identityGroupName: access.group.name })));
});

router.patch("/tactical-groups/:id/reimbursements/:claimId", async (req: Request, res: Response): Promise<void> => {
  if (!requireTacticalReimbursement(req, res)) return;
  const groupId = Number(req.params.id);
  const claimId = Number(req.params.claimId);
  const access = await getGroupAccess(req, groupId);
  if (access === null) {
    res.status(404).json({ error: "Tactical identity group not found" });
    return;
  }
  if (access === false || !canManageReimbursements(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const status = req.body.status;
  const allowed = ["submitted", "reviewing", "approved", "partially_approved", "rejected", "pending_payment", "paid"];
  if (!Number.isInteger(claimId) || !allowed.includes(status)) {
    res.status(400).json({ error: "Invalid reimbursement update" });
    return;
  }
  const approvedAmount = req.body.approvedAmount === null || req.body.approvedAmount === undefined || req.body.approvedAmount === ""
    ? null
    : Number(req.body.approvedAmount);
  if (approvedAmount !== null && (!Number.isFinite(approvedAmount) || approvedAmount < 0)) {
    res.status(400).json({ error: "Invalid approved amount" });
    return;
  }
  const [updated] = await db.update(reimbursementClaimsTable).set({
    status,
    approvedAmount,
    reviewerNotes: typeof req.body.reviewerNotes === "string" ? req.body.reviewerNotes.trim().slice(0, 10_000) : null,
    paymentReference: typeof req.body.paymentReference === "string" ? req.body.paymentReference.trim().slice(0, 500) : null,
    reviewedBy: req.tenant!.user.id,
    reviewedAt: new Date(),
    paidAt: status === "paid" ? new Date() : null,
  }).where(and(
    eq(reimbursementClaimsTable.id, claimId),
    eq(reimbursementClaimsTable.corporationId, req.tenant!.corporation.id),
    eq(reimbursementClaimsTable.identityGroupId, groupId),
  )).returning();
  if (!updated) {
    res.status(404).json({ error: "Reimbursement claim not found" });
    return;
  }
  res.json({ ...updated, identityGroupName: access.group.name });
});

export default router;
