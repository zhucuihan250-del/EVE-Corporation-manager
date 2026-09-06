import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  diplomacyCaseEventsTable,
  diplomacyCasesTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";
import {
  isDiplomacyStatus,
  resolveDiplomacyLifecycle,
  type DiplomacyStatus,
} from "../lib/diplomacy-management";

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

function actorName(req: Request): string {
  const tenant = req.tenant!;
  return tenant.actorCharacter?.eveCharacterName
    ?? tenant.user.eveCharacterName
    ?? `User ${tenant.user.id}`;
}

async function serializeCases(
  rows: Array<typeof diplomacyCasesTable.$inferSelect>,
  includeInternal: boolean,
) {
  const caseIds = rows.map((row) => row.id);
  const events = caseIds.length > 0
    ? await db
      .select()
      .from(diplomacyCaseEventsTable)
      .where(and(
        eq(diplomacyCaseEventsTable.corporationId, rows[0]!.corporationId),
        inArray(diplomacyCaseEventsTable.caseId, caseIds),
      ))
      .orderBy(asc(diplomacyCaseEventsTable.createdAt), asc(diplomacyCaseEventsTable.id))
    : [];

  return rows.map((row) => {
    const visibleEvents = events.filter((event) => (
      event.caseId === row.id
      && (includeInternal || event.visibility === "public")
    ));
    const hasSubmissionEvent = visibleEvents.some((event) => event.eventType === "submitted");
    return {
      ...row,
      internalNotes: includeInternal ? row.internalNotes : null,
      events: [
        ...(!hasSubmissionEvent ? [{
          id: 0,
          corporationId: row.corporationId,
          caseId: row.id,
          actorUserId: row.submittedBy,
          actorName: row.submitterName,
          eventType: "submitted" as const,
          visibility: "public" as const,
          fromStatus: null,
          toStatus: "submitted",
          message: null,
          createdAt: row.createdAt,
        }] : []),
        ...visibleEvents,
      ],
    };
  });
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
  res.json(await serializeCases(rows, canManage(req)));
});

router.post("/diplomacy", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  if (!tenant.actorCharacter) {
    res.status(409).json({ error: "请先用本军团角色重新登录后提交" });
    return;
  }
  const body = req.body ?? {};
  const category = body.category;
  const counterparty = typeof body.counterparty === "string" ? body.counterparty.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const description = typeof body.description === "string" ? body.description.trim() : "";
  const evidenceUrl = typeof body.evidenceUrl === "string" ? body.evidenceUrl.trim() : "";
  const urgency = body.urgency ?? "normal";
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
  const created = await db.transaction(async (tx) => {
    const [diplomacyCase] = await tx.insert(diplomacyCasesTable).values({
      corporationId: tenant.corporation.id,
      submittedBy: tenant.user.id,
      submitterCharacterId: tenant.actorCharacter!.eveCharacterId,
      submitterName: tenant.actorCharacter!.eveCharacterName,
      category,
      counterparty,
      subject,
      description,
      evidenceUrl: evidenceUrl || null,
      urgency,
    }).returning();
    await tx.insert(diplomacyCaseEventsTable).values({
      corporationId: tenant.corporation.id,
      caseId: diplomacyCase!.id,
      actorUserId: tenant.user.id,
      actorName: tenant.actorCharacter!.eveCharacterName,
      eventType: "submitted",
      toStatus: "submitted",
      message: "提交了外交问题",
    });
    return diplomacyCase!;
  });
  res.status(201).json((await serializeCases([created], false))[0]);
});

router.patch("/diplomacy/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const body = req.body ?? {};
  const hasStatus = Object.prototype.hasOwnProperty.call(body, "status");
  const hasInternalNotes = Object.prototype.hasOwnProperty.call(body, "internalNotes");
  const hasPublicReply = Object.prototype.hasOwnProperty.call(body, "publicReply");
  const hasAssignment = Object.prototype.hasOwnProperty.call(body, "assignment");
  if (!Number.isInteger(id) || id <= 0
    || (hasStatus && !isDiplomacyStatus(body.status))
    || (hasInternalNotes && typeof body.internalNotes !== "string")
    || (hasPublicReply && typeof body.publicReply !== "string")
    || (hasAssignment && body.assignment !== "self" && body.assignment !== "unassigned")
    || (typeof body.internalNotes === "string" && body.internalNotes.length > 10_000)
    || (typeof body.publicReply === "string" && body.publicReply.length > 10_000)
    || (!hasStatus && !hasInternalNotes && !hasPublicReply && !hasAssignment)
  ) {
    res.status(400).json({ error: "Invalid diplomacy update" });
    return;
  }
  const tenant = req.tenant!;
  const handlerName = actorName(req);
  const updated = await db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(diplomacyCasesTable)
      .where(and(
        eq(diplomacyCasesTable.id, id),
        eq(diplomacyCasesTable.corporationId, tenant.corporation.id),
      ))
      .for("update");
    if (!current) return null;

    const now = new Date();
    const assignment = hasAssignment
      ? body.assignment as "self" | "unassigned"
      : undefined;
    const lifecycle = resolveDiplomacyLifecycle({
      currentStatus: current.status as DiplomacyStatus,
      requestedStatus: hasStatus ? body.status as DiplomacyStatus : undefined,
      assignment,
      currentResolvedAt: current.resolvedAt,
      currentClosedAt: current.closedAt,
      now,
    });
    const internalNotes = hasInternalNotes
      ? body.internalNotes.trim() || null
      : current.internalNotes;
    const publicReply = hasPublicReply
      ? body.publicReply.trim() || null
      : current.publicReply;
    const assignedTo = assignment === "self"
      ? tenant.user.id
      : assignment === "unassigned" ? null : current.assignedTo;
    const assignedName = assignment === "self"
      ? handlerName
      : assignment === "unassigned" ? null : current.assignedName;

    const [next] = await tx.update(diplomacyCasesTable).set({
      status: lifecycle.status,
      internalNotes,
      publicReply,
      assignedTo,
      assignedName,
      resolvedAt: lifecycle.resolvedAt,
      closedAt: lifecycle.closedAt,
      updatedAt: now,
    }).where(and(
      eq(diplomacyCasesTable.id, id),
      eq(diplomacyCasesTable.corporationId, tenant.corporation.id),
    )).returning();

    const eventBase = {
      corporationId: tenant.corporation.id,
      caseId: id,
      actorUserId: tenant.user.id,
      actorName: handlerName,
    };
    if (assignment === "self" && (current.assignedTo !== assignedTo || current.assignedName !== assignedName)) {
      await tx.insert(diplomacyCaseEventsTable).values({
        ...eventBase,
        eventType: "assigned",
        message: `由 ${handlerName} 受理`,
      });
    } else if (assignment === "unassigned" && current.assignedTo !== null) {
      await tx.insert(diplomacyCaseEventsTable).values({
        ...eventBase,
        eventType: "unassigned",
        message: "已取消负责人",
      });
    }
    if (current.status !== lifecycle.status) {
      await tx.insert(diplomacyCaseEventsTable).values({
        ...eventBase,
        eventType: "status_changed",
        fromStatus: current.status,
        toStatus: lifecycle.status,
      });
    }
    if (hasPublicReply && current.publicReply !== publicReply) {
      await tx.insert(diplomacyCaseEventsTable).values({
        ...eventBase,
        eventType: "public_reply",
        message: publicReply ? "更新了处理回复" : "清除了处理回复",
      });
    }
    if (hasInternalNotes && current.internalNotes !== internalNotes) {
      await tx.insert(diplomacyCaseEventsTable).values({
        ...eventBase,
        eventType: "internal_note",
        visibility: "internal",
        message: internalNotes ? "更新了内部记录" : "清除了内部记录",
      });
    }
    return next!;
  });
  if (!updated) {
    res.status(404).json({ error: "Diplomacy case not found" });
    return;
  }
  res.json((await serializeCases([updated], true))[0]);
});

export default router;
