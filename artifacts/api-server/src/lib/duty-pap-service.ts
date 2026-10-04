import type { db } from "@workspace/db";
import { charactersTable, corporationMembershipsTable, corporationsTable, dutyPapAwardsTable, dutyPapConnectionsTable, dutyPapProgressTable, dutyPapRulesTable, papCurrenciesTable, papRecordsTable, usersTable } from "@workspace/db/schema";
import { and, asc, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { awardCustomPap } from "./pap-currency-service";
import { commonPapUnits, formatPapUnits, MAX_PAP, parsePapDecimal, validatePapRequestId } from "./pap-currency-math";
import { writePapLedger } from "./pap-ledger";
import { DUTY_PAP_FRESH_MS, DUTY_PAP_SCOPES, DutyPapError, dutyPapAdmin, dutyPapElapsed, dutyPapId, dutyPapRuleInput, dutyPapUtcDay, dutyPapVersion, type DutyPapActor } from "./duty-pap-rules";
import type { DutyPapObservation } from "./duty-pap-collector";
import { eveSystemMapNodes } from "../data/eve-system-map";
import { getFittingType } from "./fitting-data";
import { selectSiteCorporation } from "./single-corporation-rules";

type Database = typeof db;
export type DutyPapTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Rule = typeof dutyPapRulesTable.$inferSelect;
type Connection = typeof dutyPapConnectionsTable.$inferSelect;
const statusMessages: Record<string, string> = {
  authorization_required: "需要重新授权值守采集；当前时间未计入。", paused: "值守采集已暂停。", observed: "已观测，等待下一次有效采样。", eligible: "条件符合，正在累计有效值守时间。",
  daily_cap: "已达到该规则今日 UTC 发放上限。", offline: "角色不在线，当前时间未计入。", unavailable: "EVE 接口暂不可用，当前时间待核验且不计入。", stale_data: "EVE 返回缓存或过期数据，当前时间未计入。",
  not_in_fleet: "角色当前没有加入舰队。", unrecognized_fleet: "当前游戏舰队未被管理员认可。", wrong_system: "角色不在规则允许的星系内。", wrong_ship: "当前舰种不符合规则。", docked: "角色已停靠，当前规则要求未停靠。",
  left_corporation: "角色不属于本军团，当前时间未计入。", member_unavailable: "账号或角色归属已变化，当前时间未计入。", module_disabled: "军团已关闭相关功能，当前时间未计入。", currency_paused: "该 PAP 种类已暂停发放，当前时间未计入。", rate_limited: "EVE 接口正在限流，采集已退避；当前时间未计入。",
};
const systemNames = new Map(eveSystemMapNodes.map(row => [row[0], row[1]]));
function validateFilters(input: { solarSystemIds: number[]; shipTypeIds: number[] }) {
  if (input.solarSystemIds.some(id => !systemNames.has(id))) throw new DutyPapError(400, "DUTY_PAP_INVALID_SYSTEM", "包含不存在的星系。");
  if (input.shipTypeIds.some(id => { const type = getFittingType(id); return !type?.published || type.categoryId !== 6; })) throw new DutyPapError(400, "DUTY_PAP_INVALID_SHIP", "只能选择已发布的舰船类型。");
}
function publicConnection(row: Connection | null, characterName = "") {
  if (!row) return null;
  return { id: row.id, characterId: row.characterId, characterName, enabled: row.enabled, version: row.version,
    hasRequiredScopes: Boolean(row.accessToken && row.refreshToken && row.tokenExpiry && DUTY_PAP_SCOPES.every(scope => row.scopes.includes(scope))),
    status: row.lastStatus, statusMessage: row.statusMessage, lastObservedAt: row.lastObservedAt, lastCheckedAt: row.lastCheckedAt };
}
function revision(row: { version: number }) {
  if (row.version >= 2_147_483_646) throw new DutyPapError(409, "DUTY_PAP_VERSION_LIMIT", "版本达到上限，请联系管理员。");
  return row.version + 1;
}
const emptyContinuity = { lastObservedAt: null, lastEligibleRuleId: null, lastEligibleRuleVersion: null };
async function clearUserProgress(tx: DutyPapTransaction, corporationId: number, userId: number, now: Date) {
  await tx.update(dutyPapProgressTable).set({ eligibleSeconds: 0, updatedAt: now }).where(and(eq(dutyPapProgressTable.corporationId, corporationId), eq(dutyPapProgressTable.userId, userId)));
}
async function validateDutyCurrency(tx: DutyPapTransaction, corporationId: number, currencyId: number | null, enabled: boolean) {
  if (currencyId === null) return;
  const [currency] = await tx.select().from(papCurrenciesTable).where(and(eq(papCurrenciesTable.corporationId, corporationId), eq(papCurrenciesTable.id, currencyId))).for("update");
  if (!currency) throw new DutyPapError(404, "DUTY_PAP_CURRENCY_NOT_FOUND", "找不到本军团的该 PAP 种类。");
  if (enabled && !currency.issuanceEnabled) throw new DutyPapError(409, "DUTY_PAP_CURRENCY_PAUSED", "该 PAP 种类已暂停发放，不能启用规则。");
}

export function createDutyPapService({ database, now = () => new Date(), configuredCorporationId = process.env.PRIMARY_CORPORATION_ID }: { database: Database; now?: () => Date; configuredCorporationId?: string }) {
  async function site(database: Database | DutyPapTransaction) {
    const rows = await database.select({ id: corporationsTable.id, isPrimary: corporationsTable.isPrimary, isActive: corporationsTable.isActive, papEnabled: corporationsTable.papEnabled, fleetEnabled: corporationsTable.fleetEnabled }).from(corporationsTable);
    return selectSiteCorporation(rows, configuredCorporationId);
  }
  async function rules(corporationId: number) {
    const [rows, currencies] = await Promise.all([
      database.select().from(dutyPapRulesTable).where(eq(dutyPapRulesTable.corporationId, corporationId)).orderBy(asc(dutyPapRulesTable.id)),
      database.select({ id: papCurrenciesTable.id, name: papCurrenciesTable.name }).from(papCurrenciesTable).where(eq(papCurrenciesTable.corporationId, corporationId)),
    ]);
    return rows.map(({ createRequestId: _request, corporationId: _corp, ...row }) => ({ ...row, currencyName: row.currencyId === null ? "通用 PAP" : currencies.find(currency => currency.id === row.currencyId)?.name ?? "已停用种类",
      solarSystems: row.solarSystemIds.map(id => ({ id, name: systemNames.get(id) ?? String(id) })), shipTypes: row.shipTypeIds.map(id => ({ id, name: getFittingType(id)?.name.zh ?? String(id) })) }));
  }
  async function memberDashboard(actor: DutyPapActor) {
    const day = dutyPapUtcDay(now());
    const [connection, characters, progress, awards, ruleViews] = await Promise.all([
      database.select().from(dutyPapConnectionsTable).where(and(eq(dutyPapConnectionsTable.corporationId, actor.corporationId), eq(dutyPapConnectionsTable.userId, actor.userId))),
      database.select({ id: charactersTable.id, eveCharacterId: charactersTable.eveCharacterId, name: charactersTable.eveCharacterName }).from(charactersTable).where(and(eq(charactersTable.corporationId, actor.corporationId), eq(charactersTable.userId, actor.userId), isNull(charactersTable.deletedAt))).orderBy(asc(charactersTable.id)),
      database.select().from(dutyPapProgressTable).where(and(eq(dutyPapProgressTable.corporationId, actor.corporationId), eq(dutyPapProgressTable.userId, actor.userId), eq(dutyPapProgressTable.day, day))),
      database.select().from(dutyPapAwardsTable).where(and(eq(dutyPapAwardsTable.corporationId, actor.corporationId), eq(dutyPapAwardsTable.userId, actor.userId))).orderBy(desc(dutyPapAwardsTable.id)).limit(100),
      rules(actor.corporationId),
    ]);
    return { connection: publicConnection(connection[0] ?? null, characters.find(character => character.id === connection[0]?.characterId)?.name), characters, progress, awards,
      rules: ruleViews.map(rule => { const row = progress.find(item => item.ruleId === rule.id); return { ...rule, today: { eligibleSeconds: row?.eligibleSeconds ?? 0, totalEligibleSeconds: row?.totalEligibleSeconds ?? 0, awardCount: row?.awardCount ?? 0, paidAmount: row?.paidAmount ?? "0.000000" } }; }),
      pollIntervalSeconds: 60, day, timezone: "UTC" };
  }
  async function adminDashboard(actor: DutyPapActor) {
    dutyPapAdmin(actor);
    const day = dutyPapUtcDay(now());
    const [connections, progress, awards, ruleViews] = await Promise.all([
      database.select().from(dutyPapConnectionsTable).where(eq(dutyPapConnectionsTable.corporationId, actor.corporationId)).orderBy(asc(dutyPapConnectionsTable.id)).limit(500),
      database.select().from(dutyPapProgressTable).where(and(eq(dutyPapProgressTable.corporationId, actor.corporationId), eq(dutyPapProgressTable.day, day))).limit(500),
      database.select().from(dutyPapAwardsTable).where(eq(dutyPapAwardsTable.corporationId, actor.corporationId)).orderBy(desc(dutyPapAwardsTable.id)).limit(200), rules(actor.corporationId),
    ]);
    const [currencies, people] = await Promise.all([
      database.select({ id: papCurrenciesTable.id, name: papCurrenciesTable.name, issuanceEnabled: papCurrenciesTable.issuanceEnabled }).from(papCurrenciesTable).where(eq(papCurrenciesTable.corporationId, actor.corporationId)),
      database.select({ id: charactersTable.id, userId: charactersTable.userId, name: charactersTable.eveCharacterName }).from(charactersTable).where(eq(charactersTable.corporationId, actor.corporationId)),
    ]);
    return { connections: connections.map(row => ({ userId: row.userId, userName: people.find(person => person.userId === row.userId)?.name ?? `成员 ${row.userId}`, characterName: people.find(person => person.id === row.characterId)?.name ?? "已移除角色", enabled: row.enabled, status: row.lastStatus, statusMessage: row.statusMessage, lastCheckedAt: row.lastCheckedAt })), currencies, progress, awards, rules: ruleViews, day, timezone: "UTC" };
  }
  async function createRule(actor: DutyPapActor, body: unknown) {
    dutyPapAdmin(actor);
    const input = dutyPapRuleInput(body), requestId = validatePapRequestId((body as Record<string, unknown>).requestId);
    validateFilters(input);
    // New recognition rules are always paused, even when a client submits true.
    input.enabled = false;
    return database.transaction(async tx => {
      await tx.select({ id: corporationsTable.id }).from(corporationsTable).where(eq(corporationsTable.id, actor.corporationId)).for("update");
      const rows = await tx.select().from(dutyPapRulesTable).where(eq(dutyPapRulesTable.corporationId, actor.corporationId));
      const replay = rows.find(row => row.createRequestId === requestId);
      if (replay) {
        if (Object.entries(input).some(([key, value]) => JSON.stringify(replay[key as keyof Rule]) !== JSON.stringify(value))) throw new DutyPapError(409, "DUTY_PAP_REQUEST_CONFLICT", "该请求已经用于另一条规则。");
        return { rule: replay, replayed: true };
      }
      if (rows.length >= 100) throw new DutyPapError(400, "DUTY_PAP_RULE_LIMIT", "最多支持 100 条值守规则。");
      await validateDutyCurrency(tx, actor.corporationId, input.currencyId, input.enabled);
      const [rule] = await tx.insert(dutyPapRulesTable).values({ ...input, corporationId: actor.corporationId, createRequestId: requestId, createdBy: actor.userId, updatedBy: actor.userId, createdAt: now(), updatedAt: now() }).returning();
      return { rule, replayed: false };
    });
  }
  async function updateRule(actor: DutyPapActor, id: number, body: unknown) {
    dutyPapAdmin(actor); dutyPapId(id);
    const input = dutyPapRuleInput(body), stamp = now();
    validateFilters(input);
    return database.transaction(async tx => {
      const [current] = await tx.select().from(dutyPapRulesTable).where(and(eq(dutyPapRulesTable.corporationId, actor.corporationId), eq(dutyPapRulesTable.id, id))).for("update");
      if (!current) throw new DutyPapError(404, "DUTY_PAP_RULE_NOT_FOUND", "找不到本军团的该规则。");
      dutyPapVersion((body as Record<string, unknown>).version, current.version);
      await validateDutyCurrency(tx, actor.corporationId, input.currencyId, input.enabled);
      if (input.enabled) {
        const [duplicate] = await tx.select({ id: dutyPapRulesTable.id }).from(dutyPapRulesTable).where(and(eq(dutyPapRulesTable.corporationId, actor.corporationId), eq(dutyPapRulesTable.eveFleetId, input.eveFleetId), eq(dutyPapRulesTable.enabled, true)));
        if (duplicate && duplicate.id !== current.id) throw new DutyPapError(409, "DUTY_PAP_FLEET_CONFLICT", "该舰队已有启用中的值守规则。");
      }
      const [rule] = await tx.update(dutyPapRulesTable).set({ ...input, version: revision(current), updatedBy: actor.userId, updatedAt: stamp }).where(eq(dutyPapRulesTable.id, id)).returning();
      if (input.currencyId !== current.currencyId) {
        const [award] = await tx.select({ id: dutyPapAwardsTable.id }).from(dutyPapAwardsTable).where(and(eq(dutyPapAwardsTable.corporationId, actor.corporationId), eq(dutyPapAwardsTable.ruleId, id))).limit(1);
        if (award) throw new DutyPapError(409, "DUTY_PAP_CURRENCY_LOCKED", "该规则已经发放 PAP，不能更换种类；请创建新规则。");
      }
      await tx.update(dutyPapConnectionsTable).set({ ...emptyContinuity, lastStatus: "observed", statusMessage: "规则已修改，连续计时重新开始。", updatedAt: stamp }).where(and(eq(dutyPapConnectionsTable.corporationId, actor.corporationId), eq(dutyPapConnectionsTable.lastEligibleRuleId, id)));
      await tx.update(dutyPapProgressTable).set({ eligibleSeconds: 0, ruleVersion: rule!.version, updatedAt: stamp }).where(and(eq(dutyPapProgressTable.corporationId, actor.corporationId), eq(dutyPapProgressTable.ruleId, id)));
      return { rule };
    });
  }
  async function authorizeConnection(actor: DutyPapActor, input: { characterId: number; accessToken: string; refreshToken: string; tokenExpiry: Date; scopes: string[]; expectedVersion: number | null }) {
    dutyPapId(input.characterId);
    if (!input.accessToken || !input.refreshToken || !(input.tokenExpiry instanceof Date) || input.tokenExpiry.getTime() <= now().getTime() || !DUTY_PAP_SCOPES.every(scope => input.scopes.includes(scope))) throw new DutyPapError(400, "DUTY_PAP_AUTHORIZATION_REQUIRED", "值守授权缺少必需的只读权限。");
    const stamp = now();
    return database.transaction(async tx => {
      const [user] = await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, actor.userId)).for("update");
      const [membership] = await tx.select({ id: corporationMembershipsTable.id }).from(corporationMembershipsTable).where(and(eq(corporationMembershipsTable.corporationId, actor.corporationId), eq(corporationMembershipsTable.userId, actor.userId)));
      const [character] = await tx.select({ id: charactersTable.id, name: charactersTable.eveCharacterName }).from(charactersTable).where(and(eq(charactersTable.id, input.characterId), eq(charactersTable.corporationId, actor.corporationId), eq(charactersTable.userId, actor.userId), isNull(charactersTable.deletedAt)));
      if (!user || !membership || !character) throw new DutyPapError(404, "DUTY_PAP_CHARACTER_NOT_FOUND", "只能授权本人已绑定且属于本军团的角色。");
      const [current] = await tx.select().from(dutyPapConnectionsTable).where(and(eq(dutyPapConnectionsTable.corporationId, actor.corporationId), eq(dutyPapConnectionsTable.userId, actor.userId))).for("update");
      if ((current?.version ?? null) !== input.expectedVersion) throw new DutyPapError(409, "DUTY_PAP_VERSION_CONFLICT", "值守授权状态已变化，请重新开始授权。");
      const { expectedVersion: _expectedVersion, ...credentials } = input;
      const values = { corporationId: actor.corporationId, userId: actor.userId, ...credentials, scopes: [...DUTY_PAP_SCOPES], enabled: true, version: current ? revision(current) : 0, ...emptyContinuity, contextChangedAt: stamp, lastStatus: "observed", statusMessage: "授权完成并已开启值守采集，等待有效采样。", updatedAt: stamp };
      const [connection] = current ? await tx.update(dutyPapConnectionsTable).set(values).where(eq(dutyPapConnectionsTable.id, current.id)).returning() : await tx.insert(dutyPapConnectionsTable).values({ ...values, createdAt: stamp }).returning();
      await clearUserProgress(tx, actor.corporationId, actor.userId, stamp);
      return { connection: publicConnection(connection!, character.name) };
    });
  }
  async function setConnectionEnabled(actor: DutyPapActor, input: { version: number; enabled: boolean }) {
    if (typeof input.enabled !== "boolean") throw new DutyPapError(400, "DUTY_PAP_INVALID_INPUT", "采集开关无效。");
    const stamp = now();
    return database.transaction(async tx => {
      await tx.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.id, actor.userId)).for("update");
      const [current] = await tx.select().from(dutyPapConnectionsTable).where(and(eq(dutyPapConnectionsTable.corporationId, actor.corporationId), eq(dutyPapConnectionsTable.userId, actor.userId))).for("update");
      if (!current) throw new DutyPapError(404, "DUTY_PAP_CONNECTION_NOT_FOUND", "请先授权本人角色。");
      dutyPapVersion(input.version, current.version);
      if (input.enabled && !publicConnection(current)!.hasRequiredScopes) throw new DutyPapError(409, "DUTY_PAP_AUTHORIZATION_REQUIRED", "请重新授权值守采集。");
      const [connection] = await tx.update(dutyPapConnectionsTable).set({ enabled: input.enabled, version: revision(current), ...emptyContinuity, contextChangedAt: stamp, lastStatus: input.enabled ? "observed" : "paused", statusMessage: input.enabled ? "已开启采集，等待有效采样。" : statusMessages.paused!, updatedAt: stamp }).where(eq(dutyPapConnectionsTable.id, current.id)).returning();
      await clearUserProgress(tx, actor.corporationId, actor.userId, stamp);
      return { connection: publicConnection(connection!) };
    });
  }
  async function listCollectableConnections() {
    const selected = await site(database);
    if (!selected?.papEnabled || !selected.fleetEnabled) return [];
    const rows = await database.select({ connection: dutyPapConnectionsTable, eveCharacterId: charactersTable.eveCharacterId, characterName: charactersTable.eveCharacterName }).from(dutyPapConnectionsTable)
      .innerJoin(charactersTable, and(eq(charactersTable.id, dutyPapConnectionsTable.characterId), eq(charactersTable.corporationId, dutyPapConnectionsTable.corporationId), eq(charactersTable.userId, dutyPapConnectionsTable.userId)))
      .innerJoin(corporationsTable, and(eq(corporationsTable.id, dutyPapConnectionsTable.corporationId), eq(corporationsTable.id, selected.id), eq(corporationsTable.isActive, true), eq(corporationsTable.papEnabled, true), eq(corporationsTable.fleetEnabled, true)))
      .innerJoin(corporationMembershipsTable, and(eq(corporationMembershipsTable.corporationId, dutyPapConnectionsTable.corporationId), eq(corporationMembershipsTable.userId, dutyPapConnectionsTable.userId)))
      .where(and(eq(dutyPapConnectionsTable.enabled, true), isNull(charactersTable.deletedAt), isNotNull(dutyPapConnectionsTable.accessToken), isNotNull(dutyPapConnectionsTable.refreshToken), isNotNull(dutyPapConnectionsTable.tokenExpiry)))
      .orderBy(asc(dutyPapConnectionsTable.id));
    const enabledRules = await database.select({ corporationId: dutyPapRulesTable.corporationId }).from(dutyPapRulesTable).where(eq(dutyPapRulesTable.enabled, true));
    const active = new Set(enabledRules.map(rule => rule.corporationId));
    return rows.filter(row => active.has(row.connection.corporationId)).map(({ connection, ...character }) => ({ ...connection, ...character, accessToken: connection.accessToken!, refreshToken: connection.refreshToken!, tokenExpiry: connection.tokenExpiry! }));
  }
  async function processObservation(connectionId: number, expectedVersion: number, observation: DutyPapObservation): Promise<{ creditedSeconds: number; awardedAmount: string; ignored?: boolean; status?: string }> {
    dutyPapId(connectionId);
    const stamp = now();
    const [snapshot] = await database.select().from(dutyPapConnectionsTable).where(eq(dutyPapConnectionsTable.id, connectionId));
    if (!snapshot || snapshot.version !== expectedVersion || !snapshot.enabled) return { creditedSeconds: 0, awardedAmount: "0.000000", ignored: true };
    const [candidate] = observation.eveFleetId ? await database.select().from(dutyPapRulesTable).where(and(eq(dutyPapRulesTable.corporationId, snapshot.corporationId), eq(dutyPapRulesTable.eveFleetId, observation.eveFleetId), eq(dutyPapRulesTable.enabled, true))) : [];
    return database.transaction(async tx => {
      // Lock order is rule -> currency -> user -> connection -> progress -> wallet.
      // The user lock serializes all of this account's selected-character work.
      const [rule] = candidate ? await tx.select().from(dutyPapRulesTable).where(and(eq(dutyPapRulesTable.corporationId, snapshot.corporationId), eq(dutyPapRulesTable.id, candidate.id))).for("update") : [];
      let currencyName = "通用 PAP", currencyPaused = false;
      if (rule?.currencyId !== null && rule?.currencyId !== undefined) {
        const [currency] = await tx.select().from(papCurrenciesTable).where(and(eq(papCurrenciesTable.corporationId, snapshot.corporationId), eq(papCurrenciesTable.id, rule.currencyId))).for("update");
        currencyPaused = !currency?.issuanceEnabled; currencyName = currency?.name ?? "已停用种类";
      }
      const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, snapshot.userId)).for("update");
      const [connection] = await tx.select().from(dutyPapConnectionsTable).where(and(eq(dutyPapConnectionsTable.id, connectionId), eq(dutyPapConnectionsTable.corporationId, snapshot.corporationId), eq(dutyPapConnectionsTable.userId, snapshot.userId))).for("update");
      if (!connection || !connection.enabled || connection.version !== expectedVersion || connection.characterId !== snapshot.characterId) return { creditedSeconds: 0, awardedAmount: "0.000000", ignored: true };
      if (!(observation.observedAt instanceof Date) || !Number.isFinite(observation.observedAt.getTime()) || observation.observedAt.getTime() > stamp.getTime() + 5000 || observation.observedAt.getTime() <= (connection.lastCheckedAt?.getTime() ?? 0)) return { creditedSeconds: 0, awardedAmount: "0.000000", ignored: true };
      const [character] = await tx.select().from(charactersTable).where(and(eq(charactersTable.id, connection.characterId), eq(charactersTable.userId, connection.userId), eq(charactersTable.corporationId, connection.corporationId), isNull(charactersTable.deletedAt)));
      const [membership] = await tx.select({ id: corporationMembershipsTable.id }).from(corporationMembershipsTable).where(and(eq(corporationMembershipsTable.corporationId, connection.corporationId), eq(corporationMembershipsTable.userId, connection.userId)));
      const corporation = await site(tx);
      let status = observation.status in statusMessages ? observation.status : "unavailable";
      const evidence = observation.evidenceAt;
      let eligible = observation.valid && observation.online === true && observation.corporationId === connection.corporationId && observation.docked !== null && observation.shipTypeId !== null && observation.solarSystemId !== null
        && evidence instanceof Date && Number.isFinite(evidence.getTime()) && evidence.getTime() <= stamp.getTime() + 5000 && stamp.getTime() - evidence.getTime() <= DUTY_PAP_FRESH_MS;
      if (!user || !character || !membership) { eligible = false; status = "member_unavailable"; }
      else if (corporation?.id !== connection.corporationId || !corporation?.papEnabled || !corporation.fleetEnabled) { eligible = false; status = "module_disabled"; }
      else if (!DUTY_PAP_SCOPES.every(scope => connection.scopes.includes(scope))) { eligible = false; status = "authorization_required"; }
      else if (!rule?.enabled || rule.eveFleetId !== observation.eveFleetId) { eligible = false; if (observation.valid) status = "unrecognized_fleet"; }
      else if (currencyPaused) { eligible = false; status = "currency_paused"; }
      else if (eligible && rule.requireUndocked && observation.docked) { eligible = false; status = "docked"; }
      else if (eligible && rule.solarSystemIds.length && !rule.solarSystemIds.includes(observation.solarSystemId!)) { eligible = false; status = "wrong_system"; }
      else if (eligible && rule.shipTypeIds.length && !rule.shipTypeIds.includes(observation.shipTypeId!)) { eligible = false; status = "wrong_ship"; }
      if (eligible && evidence!.getTime() < Math.max(connection.contextChangedAt.getTime(), rule?.updatedAt.getTime() ?? 0)) { eligible = false; status = "stale_data"; }
      if (observation.valid && !eligible && status === "observed") status = "stale_data";
      const tokens = observation.tokenUpdate && observation.tokenUpdate.tokenExpiry.getTime() > stamp.getTime() && observation.tokenUpdate.accessToken && observation.tokenUpdate.refreshToken ? observation.tokenUpdate : {};
      if (eligible && evidence!.getTime() <= (connection.lastObservedAt?.getTime() ?? 0)) {
        // Repeated cached evidence breaks continuity. A later fresh sample may
        // start again, but does not backfill this interval or a past sample.
        await tx.update(dutyPapConnectionsTable).set({ ...tokens, lastEligibleRuleId: null, lastEligibleRuleVersion: null, lastStatus: "stale_data", statusMessage: statusMessages.stale_data!, lastCheckedAt: observation.observedAt, updatedAt: stamp }).where(eq(dutyPapConnectionsTable.id, connectionId));
        return { creditedSeconds: 0, awardedAmount: "0.000000", status: "stale_data" };
      }
      let creditedSeconds = 0, awarded = 0n;
      if (eligible && rule && user && character) {
        const day = dutyPapUtcDay(evidence!);
        // A source cache from yesterday never contributes to today's quota.
        if (day !== dutyPapUtcDay(stamp)) { eligible = false; status = "stale_data"; }
        else {
          creditedSeconds = dutyPapElapsed(connection.lastObservedAt, evidence!, connection.lastStatus === "eligible" || connection.lastStatus === "daily_cap", connection.lastEligibleRuleId === rule.id && connection.lastEligibleRuleVersion === rule.version);
          await tx.insert(dutyPapProgressTable).values({ corporationId: connection.corporationId, ruleId: rule.id, userId: connection.userId, day, ruleVersion: rule.version, updatedAt: stamp }).onConflictDoNothing();
          const [progress] = await tx.select().from(dutyPapProgressTable).where(and(eq(dutyPapProgressTable.corporationId, connection.corporationId), eq(dutyPapProgressTable.ruleId, rule.id), eq(dutyPapProgressTable.userId, connection.userId), eq(dutyPapProgressTable.day, day))).for("update");
          if (!progress) throw new DutyPapError(409, "DUTY_PAP_PROGRESS_CONFLICT", "值守进度暂不可用。");
          let seconds = (progress.ruleVersion === rule.version ? progress.eligibleSeconds : 0) + creditedSeconds, count = progress.awardCount, paid = parsePapDecimal(progress.paidAmount);
          const threshold = rule.minutesPerAward * 60, amount = parsePapDecimal(rule.awardAmount), cap = parsePapDecimal(rule.dailyCap);
          while (seconds >= threshold && paid < cap) {
            const payment = amount < cap - paid ? amount : cap - paid;
            const reason = `自动值守：${rule.name}；游戏舰队 ${rule.eveFleetId}；${rule.minutesPerAward} 分钟；UTC ${day}；序号 ${count + 1}`;
            if (rule.currencyId !== null) await awardCustomPap(tx, { corporationId: connection.corporationId, userId: user.id, userName: user.eveCharacterName ?? character.eveCharacterName, currencyId: rule.currencyId, amount: formatPapUnits(payment), reason, characterId: character.id });
            else {
              const before = commonPapUnits(user.redeemablePap) + awarded, locked = commonPapUnits(user.lockedPap), after = before + payment;
              if (after > MAX_PAP || locked > before) throw new DutyPapError(409, "DUTY_PAP_BALANCE_LIMIT", "PAP 余额超出允许范围，发放未完成。");
              await tx.update(usersTable).set({ totalPap: Number(formatPapUnits(after)), redeemablePap: Number(formatPapUnits(after)), updatedAt: stamp }).where(eq(usersTable.id, user.id));
              await writePapLedger(tx, { corporationId: connection.corporationId, userId: user.id, userName: user.eveCharacterName ?? character.eveCharacterName, type: "pap_earned", amount: Number(formatPapUnits(payment)), balanceAfter: Number(formatPapUnits(after)), lockedAfter: Number(formatPapUnits(locked)), reason, createdAt: stamp });
            }
            const [record] = await tx.insert(papRecordsTable).values({ corporationId: connection.corporationId, userId: user.id, characterId: character.id, amount: Number(formatPapUnits(payment)), currencyId: rule.currencyId, currencyName: rule.currencyId === null ? null : currencyName, type: "manual", reason, createdAt: stamp }).returning({ id: papRecordsTable.id });
            await tx.insert(dutyPapAwardsTable).values({ corporationId: connection.corporationId, ruleId: rule.id, userId: user.id, userName: user.eveCharacterName ?? character.eveCharacterName, characterName: character.eveCharacterName, day, awardIndex: ++count, ruleVersion: rule.version, ruleName: rule.name, eveFleetId: rule.eveFleetId, minutesPerAward: rule.minutesPerAward, amount: formatPapUnits(payment), currencyId: rule.currencyId, currencyName, papRecordId: record!.id, createdAt: stamp });
            paid += payment; awarded += payment; seconds -= threshold;
          }
          if (paid >= cap) seconds = 0;
          await tx.update(dutyPapProgressTable).set({ ruleVersion: rule.version, eligibleSeconds: seconds, totalEligibleSeconds: progress.totalEligibleSeconds + creditedSeconds, awardCount: count, paidAmount: formatPapUnits(paid), updatedAt: stamp }).where(eq(dutyPapProgressTable.id, progress.id));
          status = paid >= cap ? "daily_cap" : "eligible";
        }
      }
      await tx.update(dutyPapConnectionsTable).set({ ...tokens, lastObservedAt: eligible ? evidence : connection.lastObservedAt, lastEligibleRuleId: eligible ? rule!.id : null, lastEligibleRuleVersion: eligible ? rule!.version : null,
        lastStatus: status, statusMessage: statusMessages[status] ?? statusMessages.unavailable!, lastCheckedAt: observation.observedAt, lastFleetId: observation.eveFleetId, lastSolarSystemId: observation.solarSystemId, lastShipTypeId: observation.shipTypeId, updatedAt: stamp }).where(eq(dutyPapConnectionsTable.id, connectionId));
      return { creditedSeconds, awardedAmount: formatPapUnits(awarded), status };
    });
  }
  return { adminDashboard, memberDashboard, createRule, updateRule, authorizeConnection, setConnectionEnabled, listCollectableConnections, processObservation };
}
export type DutyPapService = ReturnType<typeof createDutyPapService>;

/** Called inside the existing account-link transaction, after its currency and
 * user locks. Tokens never migrate; combined day caps and audit history do. */
export async function mergeDutyPapAccounts(tx: DutyPapTransaction, corporationId: number, sourceUserId: number, destinationUserId: number, stamp = new Date()) {
  if (sourceUserId === destinationUserId) return;
  for (const userId of [sourceUserId, destinationUserId].sort((a, b) => a - b)) {
    const [connection] = await tx.select().from(dutyPapConnectionsTable).where(and(eq(dutyPapConnectionsTable.corporationId, corporationId), eq(dutyPapConnectionsTable.userId, userId))).for("update");
    if (connection) await tx.update(dutyPapConnectionsTable).set({ enabled: false, version: revision(connection), ...emptyContinuity, contextChangedAt: stamp, lastStatus: "paused", statusMessage: "账号合并后需重新确认采集角色并开启。", updatedAt: stamp }).where(eq(dutyPapConnectionsTable.id, connection.id));
  }
  const source = await tx.select().from(dutyPapProgressTable).where(and(eq(dutyPapProgressTable.corporationId, corporationId), eq(dutyPapProgressTable.userId, sourceUserId))).orderBy(asc(dutyPapProgressTable.id)).for("update");
  for (const row of source) {
    const [destination] = await tx.select().from(dutyPapProgressTable).where(and(eq(dutyPapProgressTable.corporationId, corporationId), eq(dutyPapProgressTable.userId, destinationUserId), eq(dutyPapProgressTable.ruleId, row.ruleId), eq(dutyPapProgressTable.day, row.day))).for("update");
    const offset = destination?.awardCount ?? 0;
    const awards = await tx.select().from(dutyPapAwardsTable).where(and(eq(dutyPapAwardsTable.corporationId, corporationId), eq(dutyPapAwardsTable.userId, sourceUserId), eq(dutyPapAwardsTable.ruleId, row.ruleId), eq(dutyPapAwardsTable.day, row.day))).orderBy(desc(dutyPapAwardsTable.awardIndex)).for("update");
    for (const award of awards) await tx.update(dutyPapAwardsTable).set({ userId: destinationUserId, awardIndex: award.awardIndex + offset }).where(eq(dutyPapAwardsTable.id, award.id));
    const values = { eligibleSeconds: 0, totalEligibleSeconds: (destination?.totalEligibleSeconds ?? 0) + row.totalEligibleSeconds, awardCount: offset + row.awardCount, paidAmount: formatPapUnits(parsePapDecimal(destination?.paidAmount ?? "0") + parsePapDecimal(row.paidAmount)), updatedAt: stamp };
    if (destination) {
      await tx.update(dutyPapProgressTable).set(values).where(eq(dutyPapProgressTable.id, destination.id));
      await tx.delete(dutyPapProgressTable).where(eq(dutyPapProgressTable.id, row.id));
    } else await tx.update(dutyPapProgressTable).set({ ...values, userId: destinationUserId }).where(eq(dutyPapProgressTable.id, row.id));
  }
  // Cover preserved audit rows even if an old progress row is missing.
  const leftovers = await tx.select().from(dutyPapAwardsTable).where(and(eq(dutyPapAwardsTable.corporationId, corporationId), eq(dutyPapAwardsTable.userId, sourceUserId))).orderBy(asc(dutyPapAwardsTable.id)).for("update");
  for (const award of leftovers) {
    const [last] = await tx.select({ awardIndex: dutyPapAwardsTable.awardIndex }).from(dutyPapAwardsTable).where(and(eq(dutyPapAwardsTable.corporationId, corporationId), eq(dutyPapAwardsTable.userId, destinationUserId), eq(dutyPapAwardsTable.ruleId, award.ruleId), eq(dutyPapAwardsTable.day, award.day))).orderBy(desc(dutyPapAwardsTable.awardIndex)).limit(1);
    await tx.update(dutyPapAwardsTable).set({ userId: destinationUserId, awardIndex: (last?.awardIndex ?? 0) + 1 }).where(eq(dutyPapAwardsTable.id, award.id));
  }
  await clearUserProgress(tx, corporationId, destinationUserId, stamp);
  await tx.delete(dutyPapConnectionsTable).where(and(eq(dutyPapConnectionsTable.corporationId, corporationId), eq(dutyPapConnectionsTable.userId, sourceUserId)));
}
