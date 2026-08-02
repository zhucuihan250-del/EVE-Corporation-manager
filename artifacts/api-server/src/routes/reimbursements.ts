import { Router, type IRouter, type Request, type Response } from "express";
import {
  charactersTable,
  db,
  fleetsTable,
  papRecordsTable,
  reimbursementClaimsTable,
} from "@workspace/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { KillmailValidationError, verifyKillmail } from "../lib/reimbursements";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();

router.use("/reimbursements", requireAuth, requireTenant, requireModule("reimbursement"));

function canManage(req: Request): boolean {
  return Boolean(
    req.tenant
    && (hasPermission(req.tenant, "reimbursement.manage")
      || hasRole(req.tenant.membership.role, "admin")),
  );
}

router.get("/reimbursements/fleets", async (req: Request, res: Response): Promise<void> => {
  if (!req.tenant!.corporation.isPrimary) {
    res.json([]);
    return;
  }
  const fleets = await db.select().from(fleetsTable).where(and(
    eq(fleetsTable.corporationId, req.tenant!.corporation.id),
    eq(fleetsTable.reimbursementEnabled, true),
  )).orderBy(desc(fleetsTable.createdAt));
  res.json(fleets);
});

router.get("/reimbursements", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const rows = await db.select().from(reimbursementClaimsTable).where(and(
    eq(reimbursementClaimsTable.corporationId, tenant.corporation.id),
    ...(canManage(req) ? [] : [eq(reimbursementClaimsTable.submittedBy, tenant.user.id)]),
  )).orderBy(desc(reimbursementClaimsTable.createdAt));
  res.json(rows);
});

router.post("/reimbursements", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const characterId = Number(req.body.characterId);
  const fleetId = req.body.fleetId === null || req.body.fleetId === undefined || req.body.fleetId === ""
    ? null
    : Number(req.body.fleetId);
  const killmailUrl = typeof req.body.killmailUrl === "string" ? req.body.killmailUrl.trim() : "";
  const requestedAmount = Number(req.body.requestedAmount);
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  if (
    !Number.isInteger(characterId)
    || (fleetId !== null && !Number.isInteger(fleetId))
    || !killmailUrl
    || !Number.isFinite(requestedAmount)
    || requestedAmount < 0
    || !description
    || description.length > 10_000
  ) {
    res.status(400).json({ error: "Invalid reimbursement claim" });
    return;
  }

  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, characterId),
    eq(charactersTable.userId, tenant.user.id),
    eq(charactersTable.corporationId, tenant.corporation.id),
    isNull(charactersTable.deletedAt),
  ));
  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  let fleet: typeof fleetsTable.$inferSelect | null = null;
  let fleetVerified: boolean | null = null;
  if (tenant.corporation.isPrimary) {
    if (fleetId === null) {
      res.status(400).json({ error: "请选择允许补损的舰队" });
      return;
    }
    [fleet] = await db.select().from(fleetsTable).where(and(
      eq(fleetsTable.id, fleetId),
      eq(fleetsTable.corporationId, tenant.corporation.id),
      eq(fleetsTable.reimbursementEnabled, true),
    ));
    if (!fleet) {
      res.status(404).json({ error: "补损舰队不存在" });
      return;
    }
    const [participation] = await db.select({ id: papRecordsTable.id }).from(papRecordsTable).where(and(
      eq(papRecordsTable.corporationId, tenant.corporation.id),
      eq(papRecordsTable.fleetId, fleet.id),
      eq(papRecordsTable.userId, tenant.user.id),
      eq(papRecordsTable.type, "fleet"),
    )).limit(1);
    fleetVerified = Boolean(participation);
    if (!fleetVerified) {
      res.status(409).json({ error: "系统没有找到您参加该舰队的记录" });
      return;
    }
  }

  try {
    const killmail = await verifyKillmail(killmailUrl);
    const characterVerified = killmail.victimCharacterId === character.eveCharacterId;
    if (!characterVerified) {
      res.status(409).json({ error: "击杀报告中的损失角色与申请角色不一致" });
      return;
    }
    if (killmail.totalValue > 0 && requestedAmount > killmail.totalValue) {
      res.status(409).json({ error: `申请金额不能超过击杀报告损失价值 ${Math.round(killmail.totalValue)}` });
      return;
    }
    if (fleet) {
      const start = (fleet.startedAt ?? fleet.createdAt).getTime() - 30 * 60_000;
      const end = (fleet.endedAt ?? new Date()).getTime() + 30 * 60_000;
      if (killmail.occurredAt.getTime() < start || killmail.occurredAt.getTime() > end) {
        res.status(409).json({ error: "损失时间不在该舰队的有效时间范围内" });
        return;
      }
    }
    const maximumAmount = fleet?.reimbursementRule?.maximumAmount;
    if (typeof maximumAmount === "number" && requestedAmount > maximumAmount) {
      res.status(409).json({ error: `申请金额超过该舰队上限 ${maximumAmount}` });
      return;
    }
    const [created] = await db.insert(reimbursementClaimsTable).values({
      corporationId: tenant.corporation.id,
      submittedBy: tenant.user.id,
      characterId: character.eveCharacterId,
      characterName: character.eveCharacterName,
      fleetId: fleet?.id ?? null,
      killmailId: killmail.killmailId,
      killmailHash: killmail.killmailHash,
      killmailUrl: `https://zkillboard.com/kill/${killmail.killmailId}/`,
      lossOccurredAt: killmail.occurredAt,
      shipTypeId: killmail.shipTypeId,
      shipName: killmail.shipName,
      lossValue: killmail.totalValue,
      requestedAmount,
      description,
      validation: {
        killmailVerified: true,
        characterVerified: true,
        fleetVerified,
        checkedAt: new Date().toISOString(),
        message: tenant.corporation.isPrimary ? "击杀报告、角色和舰队参与记录均已验证" : "击杀报告和角色已验证",
      },
    }).returning();
    res.status(201).json(created);
  } catch (error) {
    if (error instanceof KillmailValidationError) {
      res.status(409).json({ error: error.message });
      return;
    }
    if (error instanceof Error && /unique|duplicate/i.test(error.message)) {
      res.status(409).json({ error: "该击杀报告已经提交过补损" });
      return;
    }
    throw error;
  }
});

router.patch("/reimbursements/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const status = req.body.status;
  const allowed = ["submitted", "reviewing", "approved", "partially_approved", "rejected", "pending_payment", "paid"];
  if (!Number.isInteger(id) || !allowed.includes(status)) {
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
    eq(reimbursementClaimsTable.id, id),
    eq(reimbursementClaimsTable.corporationId, req.tenant!.corporation.id),
  )).returning();
  if (!updated) {
    res.status(404).json({ error: "Reimbursement claim not found" });
    return;
  }
  res.json(updated);
});

export default router;
