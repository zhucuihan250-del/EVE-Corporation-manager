import { Router, type IRouter, type Request, type Response } from "express";
import {
  charactersTable,
  corporationMembershipsTable,
  corporationSkillPlansTable,
  db,
  identityGroupApplicationsTable,
  identityGroupMembershipsTable,
  identityGroupSkillPlansTable,
  identityGroupsTable,
  usersTable,
  type CorporationSkillPlan,
  type RequiredSkill,
} from "@workspace/db";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { auditCharacterSkills, SkillAuditError } from "../lib/identity-skills";
import { importSkillPlanText, SkillPlanImportError } from "../lib/skill-plan-import";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();

const ALLOWED_GROUP_PERMISSIONS = new Set([
  "activity.manage",
  "diplomacy.manage",
  "economy.manage",
  "economy.view",
  "fleet.manage",
  "identity.manage",
  "recruitment.manage",
  "reimbursement.manage",
  "reimbursement.window.manage",
]);

router.use("/identity-groups", requireAuth, requireTenant, requireModule("identity"));
router.use("/identity-applications", requireAuth, requireTenant, requireModule("identity"));
router.use("/identity-skill-plans", requireAuth, requireTenant, requireModule("identity"));

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
  const seen = new Set<number>();
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const skillId = Number((item as Record<string, unknown>).skillId);
    const name = String((item as Record<string, unknown>).name ?? "").trim();
    const level = Number((item as Record<string, unknown>).level);
    if (!Number.isInteger(skillId) || skillId <= 0 || !name || !Number.isInteger(level) || level < 1 || level > 5 || seen.has(skillId)) {
      return null;
    }
    seen.add(skillId);
    result.push({ skillId, name: name.slice(0, 120), level });
  }
  return result;
}

function parsePermissions(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > ALLOWED_GROUP_PERMISSIONS.size) return null;
  const permissions = [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
  return permissions.every((permission) => ALLOWED_GROUP_PERMISSIONS.has(permission))
    ? permissions
    : null;
}

function parseSkillPlanIds(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const ids = [...new Set(value.map(Number))];
  return ids.every((id) => Number.isInteger(id) && id > 0) ? ids : null;
}

async function getSkillPlansForIds(corporationId: number, ids: number[]): Promise<CorporationSkillPlan[] | null> {
  if (ids.length === 0) return [];
  const plans = await db.select().from(corporationSkillPlansTable).where(and(
    eq(corporationSkillPlansTable.corporationId, corporationId),
    inArray(corporationSkillPlansTable.id, ids),
  ));
  return plans.length === ids.length ? plans : null;
}

async function getSkillPlansByGroup(
  corporationId: number,
  groupIds: number[],
): Promise<Map<number, CorporationSkillPlan[]>> {
  const result = new Map<number, CorporationSkillPlan[]>();
  if (groupIds.length === 0) return result;
  const rows = await db
    .select({ groupId: identityGroupSkillPlansTable.groupId, plan: corporationSkillPlansTable })
    .from(identityGroupSkillPlansTable)
    .innerJoin(corporationSkillPlansTable, and(
      eq(corporationSkillPlansTable.id, identityGroupSkillPlansTable.skillPlanId),
      eq(corporationSkillPlansTable.corporationId, corporationId),
    ))
    .where(and(
      eq(identityGroupSkillPlansTable.corporationId, corporationId),
      inArray(identityGroupSkillPlansTable.groupId, groupIds),
    ));
  for (const row of rows) {
    result.set(row.groupId, [...(result.get(row.groupId) ?? []), row.plan]);
  }
  return result;
}

router.get("/identity-groups", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const includeInactive = req.query.includeInactive === "true" && canManage(req);
  const [groups, memberships, applications] = await Promise.all([
    db.select().from(identityGroupsTable).where(and(
      eq(identityGroupsTable.corporationId, tenant.corporation.id),
      ...(includeInactive ? [] : [eq(identityGroupsTable.isActive, true)]),
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
  const plansByGroup = await getSkillPlansByGroup(tenant.corporation.id, groups.map((group) => group.id));
  const memberGroupIds = new Set(memberships.map((membership) => membership.groupId));
  const latestByGroup = new Map<number, typeof applications[number]>();
  for (const application of applications) {
    if (!latestByGroup.has(application.groupId)) latestByGroup.set(application.groupId, application);
  }
  res.json(groups.map((group) => ({
    ...group,
    skillPlans: plansByGroup.get(group.id) ?? [],
    isMember: memberGroupIds.has(group.id),
    latestApplication: latestByGroup.get(group.id) ?? null,
  })));
});

router.get("/identity-groups/:id/members", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const tenant = req.tenant!;
  const groupId = Number(req.params.id);
  if (!Number.isInteger(groupId)) {
    res.status(400).json({ error: "Invalid identity group" });
    return;
  }
  const [group] = await db.select({ id: identityGroupsTable.id }).from(identityGroupsTable).where(and(
    eq(identityGroupsTable.id, groupId),
    eq(identityGroupsTable.corporationId, tenant.corporation.id),
  ));
  if (!group) {
    res.status(404).json({ error: "Identity group not found" });
    return;
  }
  const members = await db
    .select({
      id: identityGroupMembershipsTable.id,
      groupId: identityGroupMembershipsTable.groupId,
      userId: identityGroupMembershipsTable.userId,
      characterId: identityGroupMembershipsTable.characterId,
      characterName: charactersTable.eveCharacterName,
      mainCharacterName: usersTable.eveCharacterName,
      role: corporationMembershipsTable.role,
      joinedAt: identityGroupMembershipsTable.createdAt,
    })
    .from(identityGroupMembershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, identityGroupMembershipsTable.userId))
    .innerJoin(corporationMembershipsTable, and(
      eq(corporationMembershipsTable.corporationId, tenant.corporation.id),
      eq(corporationMembershipsTable.userId, identityGroupMembershipsTable.userId),
    ))
    .leftJoin(charactersTable, and(
      eq(charactersTable.id, identityGroupMembershipsTable.characterId),
      eq(charactersTable.corporationId, tenant.corporation.id),
      isNull(charactersTable.deletedAt),
    ))
    .where(and(
      eq(identityGroupMembershipsTable.corporationId, tenant.corporation.id),
      eq(identityGroupMembershipsTable.groupId, groupId),
    ))
    .orderBy(charactersTable.eveCharacterName, usersTable.eveCharacterName);
  res.json(members);
});

router.post("/identity-groups", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const tenant = req.tenant!;
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  const category = req.body.category;
  const requiredSkills = parseRequiredSkills(req.body.requiredSkills ?? []);
  const permissions = parsePermissions(req.body.permissions ?? []);
  const skillPlanIds = parseSkillPlanIds(req.body.skillPlanIds ?? []);
  const skillPlanMatchMode = req.body.skillPlanMatchMode ?? "all";
  if (
    !name || name.length > 80
    || !["combat", "management"].includes(category)
    || !["all", "any"].includes(skillPlanMatchMode)
    || !requiredSkills || !permissions || !skillPlanIds
  ) {
    res.status(400).json({ error: "Invalid identity group" });
    return;
  }
  const skillPlans = await getSkillPlansForIds(tenant.corporation.id, skillPlanIds);
  if (!skillPlans) {
    res.status(400).json({ error: "Invalid corporation skill plan" });
    return;
  }
  const group = await db.transaction(async (tx) => {
    const [created] = await tx.insert(identityGroupsTable).values({
      corporationId: tenant.corporation.id,
      name,
      description: description.slice(0, 2_000),
      category,
      requiredSkills,
      permissions,
      skillPlanMatchMode,
      isActive: req.body.isActive !== false,
    }).returning();
    if (skillPlanIds.length) {
      await tx.insert(identityGroupSkillPlansTable).values(skillPlanIds.map((skillPlanId) => ({
        corporationId: tenant.corporation.id,
        groupId: created.id,
        skillPlanId,
      })));
    }
    return created;
  });
  res.status(201).json({ ...group, skillPlans, isMember: false, latestApplication: null });
});

router.patch("/identity-groups/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const tenant = req.tenant!;
  const id = Number(req.params.id);
  const requiredSkills = req.body.requiredSkills === undefined ? undefined : parseRequiredSkills(req.body.requiredSkills);
  const permissions = req.body.permissions === undefined ? undefined : parsePermissions(req.body.permissions);
  const skillPlanIds = req.body.skillPlanIds === undefined ? undefined : parseSkillPlanIds(req.body.skillPlanIds);
  const category = req.body.category;
  const skillPlanMatchMode = req.body.skillPlanMatchMode;
  if (
    !Number.isInteger(id)
    || requiredSkills === null || permissions === null || skillPlanIds === null
    || (category !== undefined && !["combat", "management"].includes(category))
    || (skillPlanMatchMode !== undefined && !["all", "any"].includes(skillPlanMatchMode))
  ) {
    res.status(400).json({ error: "Invalid identity group" });
    return;
  }
  const [existing] = await db.select().from(identityGroupsTable).where(and(
    eq(identityGroupsTable.id, id),
    eq(identityGroupsTable.corporationId, tenant.corporation.id),
  ));
  if (!existing) {
    res.status(404).json({ error: "Identity group not found" });
    return;
  }
  const skillPlans = skillPlanIds === undefined
    ? null
    : await getSkillPlansForIds(tenant.corporation.id, skillPlanIds);
  if (skillPlanIds !== undefined && !skillPlans) {
    res.status(400).json({ error: "Invalid corporation skill plan" });
    return;
  }
  const updates: Partial<typeof identityGroupsTable.$inferInsert> = {};
  if (typeof req.body.name === "string" && req.body.name.trim()) updates.name = req.body.name.trim().slice(0, 80);
  if (typeof req.body.description === "string") updates.description = req.body.description.trim().slice(0, 2_000);
  if (category !== undefined) updates.category = category;
  if (requiredSkills !== undefined) updates.requiredSkills = requiredSkills;
  if (permissions !== undefined) updates.permissions = permissions;
  if (skillPlanMatchMode !== undefined) updates.skillPlanMatchMode = skillPlanMatchMode;
  if (typeof req.body.isActive === "boolean") updates.isActive = req.body.isActive;
  const group = await db.transaction(async (tx) => {
    let updated = existing;
    if (Object.keys(updates).length) {
      [updated] = await tx.update(identityGroupsTable).set(updates).where(and(
        eq(identityGroupsTable.id, id),
        eq(identityGroupsTable.corporationId, tenant.corporation.id),
      )).returning();
    }
    if (skillPlanIds !== undefined) {
      await tx.delete(identityGroupSkillPlansTable).where(and(
        eq(identityGroupSkillPlansTable.corporationId, tenant.corporation.id),
        eq(identityGroupSkillPlansTable.groupId, id),
      ));
      if (skillPlanIds.length) {
        await tx.insert(identityGroupSkillPlansTable).values(skillPlanIds.map((skillPlanId) => ({
          corporationId: tenant.corporation.id,
          groupId: id,
          skillPlanId,
        })));
      }
    }
    return updated;
  });
  const responsePlans = skillPlans ?? (await getSkillPlansByGroup(tenant.corporation.id, [id])).get(id) ?? [];
  res.json({ ...group, skillPlans: responsePlans, isMember: false, latestApplication: null });
});

router.delete("/identity-groups/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid identity group" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [group] = await tx
      .select({ id: identityGroupsTable.id })
      .from(identityGroupsTable)
      .where(and(
        eq(identityGroupsTable.id, id),
        eq(identityGroupsTable.corporationId, corporationId),
      ))
      .for("update");
    if (!group) return { kind: "not_found" as const };

    const [[members], [applications]] = await Promise.all([
      tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(identityGroupMembershipsTable)
        .where(and(
          eq(identityGroupMembershipsTable.corporationId, corporationId),
          eq(identityGroupMembershipsTable.groupId, id),
        )),
      tx
        .select({ count: sql<number>`COUNT(*)::int` })
        .from(identityGroupApplicationsTable)
        .where(and(
          eq(identityGroupApplicationsTable.corporationId, corporationId),
          eq(identityGroupApplicationsTable.groupId, id),
        )),
    ]);
    const memberCount = Number(members?.count ?? 0);
    const applicationCount = Number(applications?.count ?? 0);
    if (memberCount > 0 || applicationCount > 0) {
      return { kind: "in_use" as const, memberCount, applicationCount };
    }

    await tx.delete(identityGroupsTable).where(and(
      eq(identityGroupsTable.id, id),
      eq(identityGroupsTable.corporationId, corporationId),
    ));
    return { kind: "deleted" as const };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Identity group not found" });
    return;
  }
  if (result.kind === "in_use") {
    res.status(409).json({
      error: `该身份组仍有 ${result.memberCount} 名成员和 ${result.applicationCount} 条申请记录。为保留权限与审核历史，请停用身份组，不可直接删除。`,
      code: "IDENTITY_GROUP_IN_USE",
      memberCount: result.memberCount,
      applicationCount: result.applicationCount,
    });
    return;
  }
  res.status(204).send();
});

router.get("/identity-skill-plans", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const plans = await db.select().from(corporationSkillPlansTable).where(
    eq(corporationSkillPlansTable.corporationId, req.tenant!.corporation.id),
  ).orderBy(corporationSkillPlansTable.name);
  res.json(plans);
});

router.post("/identity-skill-plans/import", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  try {
    const result = await importSkillPlanText(req.body.text);
    res.json(result);
  } catch (error) {
    if (error instanceof SkillPlanImportError) {
      res.status(error.code === "INVALID_TEXT" ? 400 : 502).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

router.post("/identity-skill-plans", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const description = typeof req.body.description === "string" ? req.body.description.trim() : "";
  const requiredSkills = parseRequiredSkills(req.body.requiredSkills ?? []);
  if (!name || name.length > 100 || !requiredSkills) {
    res.status(400).json({ error: "Invalid skill plan" });
    return;
  }
  const [plan] = await db.insert(corporationSkillPlansTable).values({
    corporationId: req.tenant!.corporation.id,
    name,
    description: description.slice(0, 2_000),
    requiredSkills,
    isActive: req.body.isActive !== false,
  }).returning();
  res.status(201).json(plan);
});

router.patch("/identity-skill-plans/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const requiredSkills = req.body.requiredSkills === undefined ? undefined : parseRequiredSkills(req.body.requiredSkills);
  if (!Number.isInteger(id) || requiredSkills === null) {
    res.status(400).json({ error: "Invalid skill plan" });
    return;
  }
  const updates: Partial<typeof corporationSkillPlansTable.$inferInsert> = {};
  if (typeof req.body.name === "string" && req.body.name.trim()) updates.name = req.body.name.trim().slice(0, 100);
  if (typeof req.body.description === "string") updates.description = req.body.description.trim().slice(0, 2_000);
  if (requiredSkills !== undefined) updates.requiredSkills = requiredSkills;
  if (typeof req.body.isActive === "boolean") updates.isActive = req.body.isActive;
  if (!Object.keys(updates).length) {
    res.status(400).json({ error: "No skill plan changes supplied" });
    return;
  }
  const [plan] = await db.update(corporationSkillPlansTable).set(updates).where(and(
    eq(corporationSkillPlansTable.id, id),
    eq(corporationSkillPlansTable.corporationId, req.tenant!.corporation.id),
  )).returning();
  if (!plan) {
    res.status(404).json({ error: "Skill plan not found" });
    return;
  }
  res.json(plan);
});

router.delete("/identity-skill-plans/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: "Invalid skill plan" });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [plan] = await tx
      .select({ id: corporationSkillPlansTable.id })
      .from(corporationSkillPlansTable)
      .where(and(
        eq(corporationSkillPlansTable.id, id),
        eq(corporationSkillPlansTable.corporationId, corporationId),
      ))
      .for("update");
    if (!plan) return { kind: "not_found" as const };

    const linkedGroups = await tx
      .select({ name: identityGroupsTable.name })
      .from(identityGroupSkillPlansTable)
      .innerJoin(identityGroupsTable, and(
        eq(identityGroupsTable.id, identityGroupSkillPlansTable.groupId),
        eq(identityGroupsTable.corporationId, corporationId),
      ))
      .where(and(
        eq(identityGroupSkillPlansTable.corporationId, corporationId),
        eq(identityGroupSkillPlansTable.skillPlanId, id),
      ))
      .orderBy(identityGroupsTable.name);
    if (linkedGroups.length > 0) {
      return { kind: "in_use" as const, groupNames: linkedGroups.map((group) => group.name) };
    }

    await tx.delete(corporationSkillPlansTable).where(and(
      eq(corporationSkillPlansTable.id, id),
      eq(corporationSkillPlansTable.corporationId, corporationId),
    ));
    return { kind: "deleted" as const };
  });

  if (result.kind === "not_found") {
    res.status(404).json({ error: "Skill plan not found" });
    return;
  }
  if (result.kind === "in_use") {
    res.status(409).json({
      error: `该技能方案仍被身份组使用：${result.groupNames.join("、")}。请先编辑这些身份组并取消关联。`,
      code: "IDENTITY_SKILL_PLAN_IN_USE",
      groupNames: result.groupNames,
    });
    return;
  }
  res.status(204).send();
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
  const [[group], [character], existingMembership, existingApplication] = await Promise.all([
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
    db.select({ id: identityGroupApplicationsTable.id }).from(identityGroupApplicationsTable).where(and(
      eq(identityGroupApplicationsTable.corporationId, tenant.corporation.id),
      eq(identityGroupApplicationsTable.groupId, groupId),
      eq(identityGroupApplicationsTable.userId, tenant.user.id),
      inArray(identityGroupApplicationsTable.status, ["pending_skill_audit", "pending_review", "needs_information"]),
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
  if (existingApplication.length > 0) {
    res.status(409).json({ error: "An application for this identity group is already pending" });
    return;
  }
  try {
    const skillPlans = (await getSkillPlansByGroup(tenant.corporation.id, [groupId])).get(groupId) ?? [];
    const skillAudit = await auditCharacterSkills({
      userId: tenant.user.id,
      corporationId: tenant.corporation.id,
      characterId,
      requiredSkills: group.requiredSkills,
      skillPlans: skillPlans.map((plan) => ({ id: plan.id, name: plan.name, requiredSkills: plan.requiredSkills })),
      skillPlanMatchMode: group.skillPlanMatchMode,
    });
    const autoApproved = group.category === "combat" && skillAudit.passed;
    const status = !skillAudit.passed ? "rejected" : autoApproved ? "approved" : "pending_review";
    const missing = skillAudit.plans?.length
      ? skillAudit.plans.filter((plan) => !plan.passed).map((plan) => plan.name)
      : skillAudit.skills.filter((skill) => !skill.passed).map((skill) => `${skill.name} ${skill.trainedLevel}/${skill.level}`);
    const application = await db.transaction(async (tx) => {
      const [created] = await tx.insert(identityGroupApplicationsTable).values({
        corporationId: tenant.corporation.id,
        groupId,
        userId: tenant.user.id,
        characterId,
        statement,
        skillAudit,
        status,
        rejectionReason: skillAudit.passed ? null : `技能不达标：${missing.join("、")}`,
        reviewerNotes: autoApproved ? "作战能力组技能自动审核通过" : null,
        reviewedAt: status === "pending_review" ? null : new Date(),
      }).returning();
      if (autoApproved) {
        await tx.insert(identityGroupMembershipsTable).values({
          corporationId: tenant.corporation.id,
          groupId,
          userId: tenant.user.id,
          characterId,
        }).onConflictDoNothing();
      }
      return created;
    });
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
  const mine = req.query.mine === "true";
  const rows = await db
    .select({
      application: identityGroupApplicationsTable,
      groupName: identityGroupsTable.name,
      groupCategory: identityGroupsTable.category,
      groupPermissions: identityGroupsTable.permissions,
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
      ...(manager && !mine ? [] : [eq(identityGroupApplicationsTable.userId, tenant.user.id)]),
    ))
    .orderBy(desc(identityGroupApplicationsTable.createdAt));
  res.json(rows.map((row) => ({
    ...row.application,
    groupName: row.groupName,
    groupCategory: row.groupCategory,
    groupPermissions: row.groupPermissions,
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
  if (status === "approved" && application.skillAudit && !application.skillAudit.passed) {
    res.status(409).json({ error: "Applications that failed the skill audit cannot be approved" });
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
