import type { db } from "@workspace/db";
import { charactersTable, usersTable } from "@workspace/db/schema";
import { and, asc, eq, isNull } from "drizzle-orm";
import { refreshSkillTokens, SkillAuditError } from "./identity-skills-client";
import { fittingId, FittingWorkbenchError, type FittingActor } from "./fitting-workbench-errors";

type Database = typeof db;
type Character = typeof charactersTable.$inferSelect;
export type FittingSkillSnapshot = {
  characterId: number; eveCharacterId: number; characterName: string;
  checkedAt: string; source: "esi";
  skills: Array<{ skillId: number; activeLevel: number; trainedLevel: number }>;
};

function unavailable() { return new FittingWorkbenchError(503, "ESI_SKILLS_UNAVAILABLE", "EVE 技能数据暂时不可用，请稍后重试。"); }
function authorize() { return new FittingWorkbenchError(409, "SKILL_AUTHORIZATION_REQUIRED", "请使用该角色重新登录 EVE 并授权读取技能，无需解绑角色。"); }

/** Read active levels independently from the identity-group audit, whose
 * trained-level semantics remain unchanged. No ESI data or response bodies are logged. */
export async function fetchFittingSkills(characterId: number, accessToken: string, request: typeof fetch = fetch): Promise<FittingSkillSnapshot["skills"]> {
  try {
    const response = await request(`https://esi.evetech.net/characters/${characterId}/skills`, {
      headers: { Authorization: `Bearer ${accessToken}`, "X-Compatibility-Date": "2020-01-01", "X-Tenant": "tranquility" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) throw authorize();
    if (!response.ok) throw unavailable();
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("skills" in payload) || !Array.isArray(payload.skills) || payload.skills.length > 2000) throw unavailable();
    const seen = new Set<number>();
    const skills: FittingSkillSnapshot["skills"] = [];
    for (const item of payload.skills) {
      if (!item || typeof item !== "object" || !Number.isSafeInteger(item.skill_id) || item.skill_id <= 0
        || !Number.isInteger(item.active_skill_level) || item.active_skill_level < 0 || item.active_skill_level > 5
        || !Number.isInteger(item.trained_skill_level) || item.trained_skill_level < 0 || item.trained_skill_level > 5
        || seen.has(item.skill_id)) throw unavailable();
      seen.add(item.skill_id);
      skills.push({ skillId: item.skill_id, activeLevel: item.active_skill_level, trainedLevel: item.trained_skill_level });
    }
    return skills.sort((left, right) => left.skillId - right.skillId);
  } catch (error) {
    if (error instanceof FittingWorkbenchError) throw error;
    throw unavailable();
  }
}

export function createFittingSkillsService(dependencies: {
  database: Database;
  fetchSkills?: typeof fetchFittingSkills;
  refreshTokens?: typeof refreshSkillTokens;
  now?: () => number;
}) {
  const database = dependencies.database, now = dependencies.now ?? Date.now;
  const fetchSkills = dependencies.fetchSkills ?? fetchFittingSkills, refreshTokens = dependencies.refreshTokens ?? refreshSkillTokens;
  const cache = new Map<string, { snapshot: FittingSkillSnapshot; expiresAt: number; token: string }>();
  const refreshes = new Map<string, Promise<Character>>();
  const reads = new Map<string, Promise<FittingSkillSnapshot>>();
  const condition = (actor: FittingActor, id?: number) => and(eq(charactersTable.userId, actor.userId), eq(charactersTable.corporationId, actor.corporationId), isNull(charactersTable.deletedAt), id === undefined ? undefined : eq(charactersTable.id, id));
  async function character(actor: FittingActor, id: number) {
    const [row] = await database.select().from(charactersTable).where(condition(actor, fittingId(id)));
    if (!row) throw new FittingWorkbenchError(404, "FITTING_CHARACTER_NOT_FOUND", "找不到本人绑定的有效军团角色。");
    return row;
  }
  async function listCharacters(actor: FittingActor) {
    const rows = await database.select({ id: charactersTable.id, eveCharacterId: charactersTable.eveCharacterId, name: charactersTable.eveCharacterName, isMain: charactersTable.isMain }).from(charactersTable).where(condition(actor)).orderBy(asc(charactersTable.id));
    return { characters: rows };
  }
  async function validCharacterToken(actor: FittingActor, id: number) {
    const key = `${actor.corporationId}:${actor.userId}:${id}`;
    const running = refreshes.get(key);
    if (running) return running;
    const task = (async () => {
      const row = await character(actor, id);
      if (!row.accessToken || !row.refreshToken || !row.tokenExpiry) throw authorize();
      if (row.tokenExpiry.getTime() > now() + 60_000) return row;
      let tokens: Awaited<ReturnType<typeof refreshSkillTokens>>;
      try { tokens = await refreshTokens(row.refreshToken); }
      catch (error) {
        // Another process may already have rotated this token. Reuse its fresh
        // result rather than reporting the old refresh token as revoked.
        const current = await character(actor, id);
        if (current.refreshToken !== row.refreshToken && current.accessToken && current.tokenExpiry && current.tokenExpiry.getTime() > now() + 60_000) return current;
        if (error instanceof SkillAuditError && error.code === "SKILL_AUTHORIZATION_REQUIRED") throw authorize();
        throw unavailable();
      }
      if (!tokens.accessToken || !tokens.refreshToken || !Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0) throw unavailable();
      const updates = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, tokenExpiry: new Date(now() + tokens.expiresIn * 1000), updatedAt: new Date(now()) };
      const [updated] = await database.update(charactersTable).set(updates).where(and(condition(actor, id), eq(charactersTable.refreshToken, row.refreshToken))).returning();
      if (!updated) {
        const current = await character(actor, id);
        if (!current.accessToken || !current.tokenExpiry || current.tokenExpiry.getTime() <= now() + 60_000) throw unavailable();
        return current;
      }
      if (row.isMain) await database.update(usersTable).set(updates).where(and(eq(usersTable.id, actor.userId), eq(usersTable.refreshToken, row.refreshToken)));
      return updated;
    })();
    refreshes.set(key, task);
    try { return await task; } finally { refreshes.delete(key); }
  }
  async function getSkills(actor: FittingActor, id: number): Promise<FittingSkillSnapshot> {
    const key = `${actor.corporationId}:${actor.userId}:${fittingId(id)}`;
    // Verify ownership and retention state even for a cached snapshot.
    const current = await character(actor, id), cached = cache.get(key);
    for (const [cacheKey, entry] of cache) if (entry.expiresAt <= now()) cache.delete(cacheKey);
    if (cached && cached.expiresAt > now() && cached.token === current.accessToken) return cached.snapshot;
    if (reads.has(key)) return reads.get(key)!;
    const task = (async () => {
      const row = await validCharacterToken(actor, id);
      const skills = await fetchSkills(row.eveCharacterId, row.accessToken!);
      // A character can be unlinked while the ESI request is in flight.
      await character(actor, id);
      const snapshot: FittingSkillSnapshot = { characterId: row.id, eveCharacterId: row.eveCharacterId, characterName: row.eveCharacterName, checkedAt: new Date(now()).toISOString(), source: "esi", skills };
      if (cache.size < 5000) cache.set(key, { snapshot, expiresAt: now() + 60_000, token: row.accessToken! });
      return snapshot;
    })();
    reads.set(key, task);
    try { return await task; } finally { reads.delete(key); }
  }
  return { listCharacters, getSkills };
}
