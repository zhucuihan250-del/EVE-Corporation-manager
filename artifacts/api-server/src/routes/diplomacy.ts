import { Router, type IRouter, type Request, type Response } from "express";
import { db, diplomacyCasesTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();

router.use("/diplomacy", requireAuth, requireTenant, requireModule("diplomacy"));

function canManage(req: Request): boolean {
  return Boolean(
    req.tenant
    && (hasPermission(req.tenant, "diplomacy.manage")
      || hasRole(req.tenant.membership.role, "admin")),
  );
}

function isSafeEvidenceUrl(value: string): boolean {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

router.get("/diplomacy", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const rows = await db
    .select()
    .from(diplomacyCasesTable)
    .where(and(
      eq(diplomacyCasesTable.corporationId, tenant.corporation.id),
      ...(canManage(req) ? [] : [eq(diplomacyCasesTable.submittedBy, tenant.user.id)]),
    ))
    .orderBy(desc(diplomacyCasesTable.createdAt));
  res.json(rows.map((row) => ({
    ...row,
    internalNotes: canManage(req) ? row.internalNotes : null,
  })));
});

router.post("/diplomacy", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  if (!tenant.actorCharacter) {
    res.status(409).json({ error: "请先用本军团角色重新登录后提交" });
    return;
  }
  const category = req.body.category;
  const counterparty = typeof req.body.counterparty === "string" ? req.body.counterparty.trim() : "";
  const subject = typeof req.body.subject === "string" ? req.body.subject.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  const evidenceUrl = typeof req.body.evidenceUrl === "string" ? req.body.evidenceUrl.trim() : "";
  const urgency = req.body.urgency ?? "normal";
  if (
    !["standings", "conflict", "cooperation", "compensation", "complaint", "other"].includes(category)
    || !["normal", "high", "urgent"].includes(urgency)
    || !counterparty || counterparty.length > 200
    || !subject || subject.length > 200
    || !description || description.length > 10_000
    || evidenceUrl.length > 2_000
    || !isSafeEvidenceUrl(evidenceUrl)
  ) {
    res.status(400).json({ error: "Invalid diplomacy submission" });
    return;
  }
  const [created] = await db.insert(diplomacyCasesTable).values({
    corporationId: tenant.corporation.id,
    submittedBy: tenant.user.id,
    submitterCharacterId: tenant.actorCharacter.eveCharacterId,
    submitterName: tenant.actorCharacter.eveCharacterName,
    category,
    counterparty,
    subject,
    description,
    evidenceUrl: evidenceUrl || null,
    urgency,
  }).returning();
  res.status(201).json(created);
});

router.patch("/diplomacy/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const status = req.body.status;
  if (
    !Number.isInteger(id)
    || !["submitted", "accepted", "investigating", "waiting", "resolved", "rejected", "closed"].includes(status)
  ) {
    res.status(400).json({ error: "Invalid diplomacy update" });
    return;
  }
  const internalNotes = typeof req.body.internalNotes === "string"
    ? req.body.internalNotes.trim().slice(0, 10_000)
    : null;
  const [updated] = await db.update(diplomacyCasesTable).set({
    status,
    internalNotes,
    assignedTo: req.tenant!.user.id,
  }).where(and(
    eq(diplomacyCasesTable.id, id),
    eq(diplomacyCasesTable.corporationId, req.tenant!.corporation.id),
  )).returning();
  if (!updated) {
    res.status(404).json({ error: "Diplomacy case not found" });
    return;
  }
  res.json(updated);
});

export default router;
