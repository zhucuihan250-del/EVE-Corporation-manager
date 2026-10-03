import type { db } from "@workspace/db";
import { corporationsTable, fittingsTable, usersTable } from "@workspace/db/schema";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { CanonicalFit, WorkbenchEftResult, WorkbenchExportResult, WorkbenchSimulation } from "./fitting-engine-types";
import type { FittingLanguage } from "./fitting-data";
import { fittingId, fittingObject, fittingVersion, FittingWorkbenchError, type FittingActor } from "./fitting-workbench-errors";
import type { createFittingSkillsService } from "./fitting-workbench-skills";

type Database = typeof db;
type Saved = typeof fittingsTable.$inferSelect;
export type FittingWorkbenchEngine = {
  validateCanonicalFit(value: unknown): CanonicalFit;
  resolveWorkbenchFit(value: unknown): CanonicalFit;
  simulateWorkbench(fit: CanonicalFit, language: FittingLanguage, skills?: Record<number, number>): Promise<WorkbenchSimulation>;
  parseEft(text: string, language?: FittingLanguage): Promise<WorkbenchEftResult>;
  exportEft(fit: CanonicalFit): Promise<WorkbenchExportResult>;
};
export type FittingSimulationWithSource = WorkbenchSimulation & {
  skillSource: { mode: "all5" | "none" | "character"; characterId?: number; characterName?: string; checkedAt?: string };
};

export function canManageCorporationFittings(actor: FittingActor): boolean {
  return ["fc", "admin", "controller"].includes(actor.role) || actor.permissions.includes("fleet.manage");
}
function language(value: unknown): FittingLanguage {
  if (value === undefined) return "zh";
  if (value !== "en" && value !== "zh") throw new FittingWorkbenchError(400, "FITTING_INVALID_LANGUAGE", "请选择中文或英文。");
  return value;
}
function savedName(value: unknown, fallback?: string) {
  const name = typeof value === "string" ? value.trim() : fallback ?? "";
  if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name)) throw new FittingWorkbenchError(400, "FITTING_INVALID_NAME", "配置名称须为 1–100 字。");
  return name;
}
function description(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 2000 || value.includes("\u0000")) throw new FittingWorkbenchError(400, "FITTING_INVALID_DESCRIPTION", "配置说明最多 2000 字。");
  return value.trim();
}
function readable(actor: FittingActor, id?: number) {
  return and(eq(fittingsTable.corporationId, actor.corporationId), id === undefined ? undefined : eq(fittingsTable.id, fittingId(id)), or(eq(fittingsTable.visibility, "corporation"), and(eq(fittingsTable.visibility, "personal"), eq(fittingsTable.ownerUserId, actor.userId))));
}
function editable(actor: FittingActor, id: number) {
  return and(eq(fittingsTable.corporationId, actor.corporationId), eq(fittingsTable.id, fittingId(id)), or(and(eq(fittingsTable.visibility, "personal"), eq(fittingsTable.ownerUserId, actor.userId)), canManageCorporationFittings(actor) ? eq(fittingsTable.visibility, "corporation") : undefined));
}
function view(actor: FittingActor, row: Saved) {
  return { id: row.id, name: row.name, description: row.description, visibility: row.visibility, ownerUserId: row.ownerUserId, authorName: row.authorName, fit: row.fit, simulation: row.simulation, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, canEdit: row.visibility === "personal" ? row.ownerUserId === actor.userId : canManageCorporationFittings(actor) };
}

export function createFittingWorkbenchService(dependencies: { database: Database; engine: FittingWorkbenchEngine; skills: ReturnType<typeof createFittingSkillsService> }) {
  const { database, engine, skills } = dependencies;
  async function simulate(actor: FittingActor, value: unknown, legacy = false): Promise<FittingSimulationWithSource> {
    const body = fittingObject(value), lng = language(body.language);
    const fit = legacy ? engine.resolveWorkbenchFit(body) : engine.validateCanonicalFit(body.fit);
    if (Object.hasOwn(body, "skills")) throw new FittingWorkbenchError(400, "FITTING_SERVER_SKILLS_REQUIRED", "角色技能由网站读取，请通过技能模式选择角色。");
    let skillLevels: Record<number, number> | undefined;
    let skillSource: FittingSimulationWithSource["skillSource"] = { mode: fit.skillProfile.mode };
    if (fit.skillProfile.mode === "character") {
      const snapshot = await skills.getSkills(actor, fittingId(fit.skillProfile.characterId));
      skillLevels = Object.fromEntries(snapshot.skills.map(item => [item.skillId, item.activeLevel]));
      skillSource = { mode: "character", characterId: snapshot.characterId, characterName: snapshot.characterName, checkedAt: snapshot.checkedAt };
    }
    const result = await engine.simulateWorkbench(fit, lng, skillLevels);
    return { ...result, skillSource };
  }
  async function importFit(value: unknown) {
    const body = fittingObject(value), lng = language(body.language);
    if (typeof body.text !== "string" || !body.text.trim() || Buffer.byteLength(body.text, "utf8") > 64 * 1024) throw new FittingWorkbenchError(400, "FITTING_INVALID_EFT", "请粘贴有效的游戏配装文本，最多 64 KB。");
    return engine.parseEft(body.text, lng);
  }
  async function exportFit(value: unknown) {
    const body = fittingObject(value);
    language(body.language);
    return engine.exportEft(engine.validateCanonicalFit(body.fit));
  }
  async function listSaved(actor: FittingActor, options: { cursor?: unknown; limit?: unknown; visibility?: unknown } = {}) {
    const cursor = options.cursor === undefined ? undefined : fittingId(options.cursor);
    const limit = options.limit === undefined ? 100 : fittingId(options.limit);
    if (limit > 200) throw new FittingWorkbenchError(400, "FITTING_INVALID_LIMIT", "每页最多显示 200 份配置。");
    if (options.visibility !== undefined && !["personal", "corporation", "all"].includes(String(options.visibility))) throw new FittingWorkbenchError(400, "FITTING_INVALID_VISIBILITY", "配置范围无效。");
    const rows = await database.select().from(fittingsTable).where(and(readable(actor), cursor === undefined ? undefined : lt(fittingsTable.id, cursor), options.visibility === "personal" || options.visibility === "corporation" ? eq(fittingsTable.visibility, options.visibility) : undefined)).orderBy(desc(fittingsTable.id)).limit(limit + 1);
    return { fittings: rows.slice(0, limit).map(row => view(actor, row)), nextCursor: rows.length > limit ? rows[limit - 1]!.id : null, canManageCorporation: canManageCorporationFittings(actor) };
  }
  async function getSaved(actor: FittingActor, id: number) {
    const [row] = await database.select().from(fittingsTable).where(readable(actor, id));
    if (!row) throw new FittingWorkbenchError(404, "FITTING_NOT_FOUND", "找不到该配置。");
    return { fitting: view(actor, row) };
  }
  async function createSaved(actor: FittingActor, value: unknown) {
    const body = fittingObject(value);
    if (body.visibility !== "personal" && body.visibility !== "corporation") throw new FittingWorkbenchError(400, "FITTING_INVALID_VISIBILITY", "请选择个人配置或军团配置。");
    if (body.visibility === "corporation" && !canManageCorporationFittings(actor)) throw new FittingWorkbenchError(403, "FITTING_MANAGER_REQUIRED", "只有 FC 或具有舰队管理权限的成员可以管理军团配置。");
    const name = savedName(body.name), notes = description(body.description);
    const fit = engine.validateCanonicalFit(body.fit);
    fit.name = name;
    const simulation = await simulate(actor, { fit, language: body.language });
    const visibility = body.visibility;
    const row = await database.transaction(async tx => {
      // Serialize each quota across workers after engine/ESI work. NO KEY
      // UPDATE is mutually exclusive for the same quota, but permits the FK
      // KEY SHARE checks on both parent rows when personal and corporation
      // saves run together; FOR UPDATE could otherwise deadlock those inserts.
      if (visibility === "corporation") await tx.select({ id: corporationsTable.id }).from(corporationsTable).where(eq(corporationsTable.id, actor.corporationId)).for("no key update");
      else await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, actor.userId)).for("no key update");
      const [{ count }] = await tx.select({ count: sql<number>`count(*)::integer` }).from(fittingsTable).where(and(eq(fittingsTable.corporationId, actor.corporationId), eq(fittingsTable.visibility, visibility), visibility === "personal" ? eq(fittingsTable.ownerUserId, actor.userId) : undefined));
      if (count >= (visibility === "personal" ? 250 : 500)) throw new FittingWorkbenchError(409, "FITTING_STORAGE_LIMIT", visibility === "personal" ? "个人配置最多保存 250 份，请先整理旧配置。" : "军团配置最多保存 500 份，请先整理旧配置。");
      const [saved] = await tx.insert(fittingsTable).values({ corporationId: actor.corporationId, visibility, ownerUserId: visibility === "personal" ? actor.userId : null, createdBy: actor.userId, updatedBy: actor.userId, authorName: actor.userName, name, description: notes, fit: fit as unknown as Record<string, unknown>, simulation: simulation as unknown as Record<string, unknown> }).returning();
      return saved;
    });
    return { fitting: view(actor, row) };
  }
  async function updateSaved(actor: FittingActor, id: number, value: unknown) {
    const body = fittingObject(value), version = fittingVersion(body.version);
    const current = (await getSaved(actor, id)).fitting;
    if (!current.canEdit) throw new FittingWorkbenchError(403, "FITTING_MANAGER_REQUIRED", "你没有修改该军团配置的权限。");
    if (current.version !== version) throw new FittingWorkbenchError(409, "FITTING_VERSION_CONFLICT", "配置已被修改，请刷新后重试。");
    if (body.visibility !== undefined && body.visibility !== current.visibility) throw new FittingWorkbenchError(400, "FITTING_VISIBILITY_IMMUTABLE", "请使用另存为创建不同范围的配置。");
    const name = savedName(body.name), notes = description(body.description), fit = engine.validateCanonicalFit(body.fit);
    fit.name = name;
    const simulation = await simulate(actor, { fit, language: body.language });
    const [row] = await database.update(fittingsTable).set({ name, description: notes, fit: fit as unknown as Record<string, unknown>, simulation: simulation as unknown as Record<string, unknown>, updatedBy: actor.userId, updatedAt: new Date(), version: version + 1 }).where(and(editable(actor, id), eq(fittingsTable.version, version))).returning();
    if (!row) throw new FittingWorkbenchError(409, "FITTING_VERSION_CONFLICT", "配置已被修改或移除，请刷新后重试。");
    return { fitting: view(actor, row) };
  }
  async function deleteSaved(actor: FittingActor, id: number, value: unknown) {
    const version = fittingVersion(fittingObject(value).version), current = (await getSaved(actor, id)).fitting;
    if (!current.canEdit) throw new FittingWorkbenchError(403, "FITTING_MANAGER_REQUIRED", "你没有删除该军团配置的权限。");
    const [row] = await database.delete(fittingsTable).where(and(editable(actor, id), eq(fittingsTable.version, version))).returning({ id: fittingsTable.id });
    if (!row) throw new FittingWorkbenchError(409, "FITTING_VERSION_CONFLICT", "配置已被修改或移除，请刷新后重试。");
    return { deleted: true };
  }
  return { simulate, importFit, exportFit, listSaved, getSaved, createSaved, updateSaved, deleteSaved, listCharacters: skills.listCharacters, getSkills: skills.getSkills };
}
