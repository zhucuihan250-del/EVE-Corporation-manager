import { Router, type IRouter, type NextFunction, type Request, type Response } from "express";
import {
  charactersTable,
  corporationsTable,
  db,
  reimbursementClaimsTable,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { KillmailValidationError, listCharacterLosses, verifyKillmail } from "../lib/reimbursements";
import { hasPermission, requireModule, requirePermission, requireTenant } from "../lib/tenant";

const router: IRouter = Router();

router.use("/reimbursements", requireAuth, requireTenant, requireModule("reimbursement"));

router.patch(
  "/reimbursements/window",
  requirePermission("reimbursement.window.manage"),
  async (req: Request, res: Response): Promise<void> => {
    if (typeof req.body.open !== "boolean") {
      res.status(400).json({ error: "Invalid reimbursement window state" });
      return;
    }
    const [updated] = await db
      .update(corporationsTable)
      .set({ reimbursementOpen: req.body.open })
      .where(eq(corporationsTable.id, req.tenant!.corporation.id))
      .returning({ open: corporationsTable.reimbursementOpen });
    res.json(updated);
  },
);

function requireReimbursementOpen(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.tenant!.corporation.reimbursementOpen) {
    res.status(423).json({
      error: "本军团补损窗口已关闭",
      code: "REIMBURSEMENT_WINDOW_CLOSED",
    });
    return;
  }
  next();
}

router.use("/reimbursements", requireReimbursementOpen);

function canManage(req: Request): boolean {
  return Boolean(
    req.tenant
    && (hasPermission(req.tenant, "reimbursement.manage")
      || hasRole(req.tenant.membership.role, "admin")),
  );
}

router.get("/reimbursements/fleets", async (req: Request, res: Response): Promise<void> => {
  res.json([]);
});

router.get("/reimbursements", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const rows = await db.select().from(reimbursementClaimsTable).where(and(
    eq(reimbursementClaimsTable.corporationId, tenant.corporation.id),
    ...(canManage(req) ? [] : [eq(reimbursementClaimsTable.submittedBy, tenant.user.id)]),
  )).orderBy(desc(reimbursementClaimsTable.createdAt));
  res.json(rows);
});

router.get("/reimbursements/losses", async (req: Request, res: Response): Promise<void> => {
  const characterId = Number(req.query.characterId);
  if (!Number.isInteger(characterId)) {
    res.status(400).json({ error: "请选择需要查询的损失角色" });
    return;
  }
  const [character] = await db.select().from(charactersTable).where(and(
    eq(charactersTable.id, characterId),
    eq(charactersTable.userId, req.tenant!.user.id),
    eq(charactersTable.corporationId, req.tenant!.corporation.id),
    isNull(charactersTable.deletedAt),
  ));
  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  try {
    const losses = await listCharacterLosses(character.eveCharacterId);
    const existing = losses.length === 0
      ? []
      : await db.select({
        id: reimbursementClaimsTable.id,
        killmailId: reimbursementClaimsTable.killmailId,
        status: reimbursementClaimsTable.status,
      }).from(reimbursementClaimsTable).where(and(
        eq(reimbursementClaimsTable.corporationId, req.tenant!.corporation.id),
        inArray(reimbursementClaimsTable.killmailId, losses.map((loss) => loss.killmailId)),
      ));
    const claimsByKillmail = new Map(existing.map((claim) => [claim.killmailId, claim]));
    res.json(losses.map((loss) => {
      const claim = claimsByKillmail.get(loss.killmailId);
      return {
        killmailId: loss.killmailId,
        killmailUrl: `https://zkillboard.com/kill/${loss.killmailId}/`,
        lossOccurredAt: loss.occurredAt,
        shipTypeId: loss.shipTypeId,
        shipName: loss.shipName,
        lossValue: loss.totalValue,
        alreadySubmitted: Boolean(claim),
        claimId: claim?.id ?? null,
        claimStatus: claim?.status ?? null,
      };
    }));
  } catch (error) {
    if (error instanceof KillmailValidationError) {
      res.status(502).json({ error: error.message });
      return;
    }
    throw error;
  }
});

router.post("/reimbursements", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const characterId = Number(req.body.characterId);
  const killmailId = Number(req.body.killmailId);
  const legacyKillmailUrl = typeof req.body.killmailUrl === "string" ? req.body.killmailUrl.trim() : "";
  const killmailReference = Number.isSafeInteger(killmailId) && killmailId > 0
    ? String(killmailId)
    : legacyKillmailUrl;
  const description = typeof req.body.description === "string" && req.body.description.trim()
    ? req.body.description.trim().slice(0, 10_000)
    : "通过 zKillboard 自动提交";
  if (
    !Number.isInteger(characterId)
    || !killmailReference
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

  try {
    const killmail = await verifyKillmail(killmailReference);
    const characterVerified = killmail.victimCharacterId === character.eveCharacterId;
    if (!characterVerified) {
      res.status(409).json({ error: "击杀报告中的损失角色与申请角色不一致" });
      return;
    }
    const [created] = await db.insert(reimbursementClaimsTable).values({
      corporationId: tenant.corporation.id,
      submittedBy: tenant.user.id,
      characterId: character.eveCharacterId,
      characterName: character.eveCharacterName,
      fleetId: null,
      killmailId: killmail.killmailId,
      killmailHash: killmail.killmailHash,
      killmailUrl: `https://zkillboard.com/kill/${killmail.killmailId}/`,
      lossOccurredAt: killmail.occurredAt,
      shipTypeId: killmail.shipTypeId,
      shipName: killmail.shipName,
      lossValue: killmail.totalValue,
      requestedAmount: killmail.totalValue,
      description,
      validation: {
        killmailVerified: true,
        characterVerified: true,
        fleetVerified: null,
        checkedAt: new Date().toISOString(),
        message: "zKillboard 击杀报告和损失角色已自动验证",
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
