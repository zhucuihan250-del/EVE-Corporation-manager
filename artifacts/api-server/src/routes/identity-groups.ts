import { Router, type IRouter, type Request, type Response } from "express";
import {
  charactersTable,
  db,
  identityGroupApplicationsTable,
  identityGroupMembershipsTable,
  identityGroupsTable,
  type RequiredSkill,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { auditCharacterSkills, SkillAuditError } from "../lib/identity-skills";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();

router.use("/identity-groups", requireAuth, requireTenant, requireModule("identity"));
router.use("/identity-applications", requireAuth, requireTenant, requireModule("identity"));

function canManage(req: Request): boolean {
  return Boolean(
    req.tenant
    && (hasPermission(req.tenant, "identity.manage")
      || hasRole(req.tenant.membership.role, "admin")),
  );
}

function parseRequiredSkills(value: unknown): RequiredSkill[] | null {
  if (!Array.isArray(value) || value.length > 100) return null;
  const result: RequiredSkill[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const skillId = Number((item as Record<string, unknown>).skillId);
    const name = String((item as Record<string, unknown>).name ?? "").trim();
    const level = Number((item as Record<string, unknown>).level);
    if (!Number.isInteger(skillId) || skillId <= 0 || !name || !Number.isInteger(level) || level < 1 || level > 5) {
      return null;
    }
    result.push({ skillId, name: name.slice(0, 120), level });
  }
  return result;
}

router.get("/identity-groups", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const [groups, memberships, applications] = await Promise.all([
    db.select().from(identityGroupsTable).where(and(
      eq(identityGroupsTable.corporationId, tenant.corporation.id),
      eq(identityGroupsTable.isActive, true),
    )).orderBy(identityGroupsTable.category, identityGroupsTable.name),
    db.select().from(identityGroupMembershipsTable).where(and(
      eq(identityGroupMembershipsTable.corporationId, tenant.corporation.id),
      eq(identityGroupMembershipsTable.userId, tenant.user.id),
    )),
    db.select().from(identityGroupApplicationsTable).where(and(
      eq(identityGroupApplicationsTable.corporationId, tenant.corporation.id),
      eq(identityGroupApplicationsTable.userId, tenant.user.id),
    )).orderBy(desc(identityGroupApplicationsTable.createdAt)),
  ]);
  const memberGroupIds = new Set(memberships.map((membership) => membership.groupId));
  const latestByGroup = new Map<number, typeof applications[number]>();
  for (const application of applications) {
    if (!latestByGroup.has(application.groupId)) latestByGroup.set(application.groupId, application);
  }
  res.json(groups.map((group) => ({
    ...group,
    isMember: memberGroupIds.has(group.id),
    latestApplication: latestByGroup.get(group.id) ?? null,
  })));
});

router.post("/identity-groups", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  const category = req.body.category;
  const requiredSkills = parseRequiredSkills(req.body.requiredSkills ?? []);
  if (!name || name.length > 80 || !["combat", "management"].includes(category) || !requiredSkills) {
    res.status(400).json({ error: "Invalid identity group" });
    return;
  }
  const [group] = await db.insert(identityGroupsTable).values({
    corporationId: req.tenant!.corporation.id,
    name,
    description: description.slice(0, 2_000),
    category,
    requiredSkills,
    permissions: [],
  }).returning();
  res.status(201).json(group);
});

router.patch("/identity-groups/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const requiredSkills = req.body.requiredSkills === undefined
    ? undefined
    : parseRequiredSkills(req.body.requiredSkills);
  if (!Number.isInteger(id) || requiredSkills === null) {
    res.status(400).json({ error: "Invalid identity group" });
    return;
  }
  const updates: Record<string, unknown> = {};
  if (typeof req.body.name === "string" && req.body.name.trim()) updates.name = req.body.name.trim().slice(0, 80);
  if (typeof req.body.description === "string") updates.description = req.body.description.trim().slice(0, 2_000);
  if (requiredSkills !== undefined) updates.requiredSkills = requiredSkills;
  if (typeof req.body.isActive === "boolean") updates.isActive = req.body.isActive;
  const [group] = await db.update(identityGroupsTable).set(updates).where(and(
    eq(identityGroupsTable.id, id),
    eq(identityGroupsTable.corporationId, req.tenant!.corporation.id),
  )).returning();
  if (!group) {
    res.status(404).json({ error: "Identity group not found" });
    return;
  }
  res.json(group);
});

router.post("/identity-groups/:id/applications", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const groupId = Number(req.params.id);
  const characterId = Number(req.body.characterId);
  const statement = typeof req.body.statement === "string" ? req.body.statement.trim() : "";
  if (!Number.isInteger(groupId) || !Number.isInteger(characterId) || statement.length > 5_000) {
    res.status(400).json({ error: "Invalid application" });
    return;
  }
  const [[group], [character], existingMembership] = await Promise.all([
    db.select().from(identityGroupsTable).where(and(
      eq(identityGroupsTable.id, groupId),
      eq(identityGroupsTable.corporationId, tenant.corporation.id),
      eq(identityGroupsTable.isActive, true),
    )),
    db.select().from(charactersTable).where(and(
      eq(charactersTable.id, characterId),
      eq(charactersTable.userId, tenant.user.id),
      eq(charactersTable.corporationId, tenant.corporation.id),
      isNull(charactersTable.deletedAt),
    )),
    db.select({ id: identityGroupMembershipsTable.id }).from(identityGroupMembershipsTable).where(and(
      eq(identityGroupMembershipsTable.corporationId, tenant.corporation.id),
      eq(identityGroupMembershipsTable.groupId, groupId),
      eq(identityGroupMembershipsTable.userId, tenant.user.id),
    )),
  ]);
  if (!group || !character) {
    res.status(404).json({ error: "Identity group or character not found" });
    return;
  }
  if (existingMembership.length > 0) {
    res.status(409).json({ error: "Already a member of this identity group" });
    return;
  }
  try {
    const skillAudit = await auditCharacterSkills({
      userId: tenant.user.id,
      corporationId: tenant.corporation.id,
      characterId,
      requiredSkills: group.requiredSkills,
    });
    const missing = skillAudit.skills.filter((skill) => !skill.passed);
    const [application] = await db.insert(identityGroupApplicationsTable).values({
      corporationId: tenant.corporation.id,
      groupId,
      userId: tenant.user.id,
      characterId,
      statement,
      skillAudit,
      status: skillAudit.passed ? "pending_review" : "rejected",
      rejectionReason: skillAudit.passed
        ? null
        : `技能不达标：${missing.map((skill) => `${skill.name} ${skill.trainedLevel}/${skill.level}`).join("、")}`,
      reviewedAt: skillAudit.passed ? null : new Date(),
    }).returning();
    res.status(201).json(application);
  } catch (error) {
    if (error instanceof SkillAuditError) {
      res.status(error.code === "CHARACTER_NOT_FOUND" ? 404 : 409).json({
        error: error.message,
        code: error.code,
      });
      return;
    }
    throw error;
  }
});

router.get("/identity-applications", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const manager = canManage(req);
  const rows = await db
    .select({
      application: identityGroupApplicationsTable,
      groupName: identityGroupsTable.name,
      groupCategory: identityGroupsTable.category,
      characterName: charactersTable.eveCharacterName,
      applicantName: charactersTable.eveCharacterName,
    })
    .from(identityGroupApplicationsTable)
    .innerJoin(identityGroupsTable, and(
      eq(identityGroupsTable.id, identityGroupApplicationsTable.groupId),
      eq(identityGroupsTable.corporationId, tenant.corporation.id),
    ))
    .innerJoin(charactersTable, and(
      eq(charactersTable.id, identityGroupApplicationsTable.characterId),
      eq(charactersTable.corporationId, tenant.corporation.id),
    ))
    .where(and(
      eq(identityGroupApplicationsTable.corporationId, tenant.corporation.id),
      ...(manager ? [] : [eq(identityGroupApplicationsTable.userId, tenant.user.id)]),
    ))
    .orderBy(desc(identityGroupApplicationsTable.createdAt));
  res.json(rows.map((row) => ({
    ...row.application,
    groupName: row.groupName,
    groupCategory: row.groupCategory,
    characterName: row.characterName,
    applicantName: row.applicantName,
  })));
});

router.patch("/identity-applications/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const status = req.body.status;
  if (!Number.isInteger(id) || !["pending_review", "needs_information", "approved", "rejected"].includes(status)) {
    res.status(400).json({ error: "Invalid review" });
    return;
  }
  const tenant = req.tenant!;
  const [application] = await db.select().from(identityGroupApplicationsTable).where(and(
    eq(identityGroupApplicationsTable.id, id),
    eq(identityGroupApplicationsTable.corporationId, tenant.corporation.id),
  ));
  if (!application) {
    res.status(404).json({ error: "Application not found" });
    return;
  }
  const reviewerNotes = typeof req.body.reviewerNotes === "string" ? req.body.reviewerNotes.trim().slice(0, 5_000) : null;
  const [updated] = await db.transaction(async (tx) => {
    const rows = await tx.update(identityGroupApplicationsTable).set({
      status,
      reviewerNotes,
      rejectionReason: status === "rejected" ? reviewerNotes || "申请未获批准" : null,
      reviewedBy: tenant.user.id,
      reviewedAt: new Date(),
    }).where(and(
      eq(identityGroupApplicationsTable.id, id),
      eq(identityGroupApplicationsTable.corporationId, tenant.corporation.id),
    )).returning();
    if (status === "approved") {
      await tx.insert(identityGroupMembershipsTable).values({
        corporationId: tenant.corporation.id,
        groupId: application.groupId,
        userId: application.userId,
        characterId: application.characterId,
        grantedBy: tenant.user.id,
      }).onConflictDoNothing();
    }
    return rows;
  });
  res.json(updated);
});

export default router;
