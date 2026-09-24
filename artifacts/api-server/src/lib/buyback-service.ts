import { randomUUID } from "node:crypto";
import type { db } from "@workspace/db";
import { buybackQuotesTable, buybackRulesTable, buybackSettingsTable, corporationsTable } from "@workspace/db/schema";
import { and, asc, desc, eq, gte, sql } from "drizzle-orm";
import {
  BuybackError, DEFAULT_BUYBACK_SETTINGS, calculateBuybackQuote, effectiveBuybackRule,
  parseBuybackClipboard, validateBuybackRule, validateBuybackSettings,
  type BuybackMarketPrice, type BuybackRule, type BuybackSettings,
} from "./buyback-calculation";
import type { BuybackCatalogTarget, BuybackCatalogType } from "./buyback-catalog";

type Database = typeof db;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type BuybackActor = { corporationId: number; userId: number; userName: string; role: string };
export type BuybackServiceDependencies = {
  database: Database;
  resolveTypes(names: string[]): Promise<Map<string, BuybackCatalogType>>;
  getTarget(scope: "category" | "type", targetId: number): Promise<BuybackCatalogTarget | null>;
  getPrices(typeIds: number[]): Promise<Map<number, BuybackMarketPrice>>;
};

function settingsView(row: typeof buybackSettingsTable.$inferSelect | undefined): BuybackSettings {
  if (!row) return { ...DEFAULT_BUYBACK_SETTINGS };
  return {
    enabled: row.enabled, defaultEnabled: row.defaultEnabled, priceBasis: row.priceBasis,
    ratePercent: Number(row.ratePercent), fixedPrice: row.fixedPrice,
    quoteValidityMinutes: row.quoteValidityMinutes, version: row.version,
  };
}

function ruleView(row: typeof buybackRulesTable.$inferSelect): BuybackRule {
  return {
    id: row.id, scope: row.scope, targetId: row.targetId, targetName: row.targetName,
    enabled: row.enabled, priceBasis: row.priceBasis,
    ratePercent: row.ratePercent === null ? null : Number(row.ratePercent), fixedPrice: row.fixedPrice,
  };
}

function assertAdmin(actor: BuybackActor) {
  if (!new Set(["admin", "controller"]).has(actor.role)) throw new BuybackError(403, "BUYBACK_ADMIN_REQUIRED", "只有管理员或总监可以管理回收规则。");
}

function assertVersion(value: unknown, current: number) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 2_147_483_647) throw new BuybackError(400, "INVALID_BUYBACK_VERSION", "规则版本无效，请刷新页面。");
  if (value !== current) throw new BuybackError(409, "BUYBACK_VERSION_CONFLICT", "回收规则已被修改，请刷新后重新操作。");
}

function quoteView(row: typeof buybackQuotesTable.$inferSelect) {
  // Histories omit raw pasted text and unrelated configuration snapshots. The
  // immutable per-line price/rate and settings version remain available.
  return {
    id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt,
    totalIsk: row.totalIsk, complete: row.complete, settingsVersion: row.settingsVersion,
    submitterName: row.submitterName, lines: row.lines, requestId: row.requestId,
  };
}

/** Bounded per-process abuse control; the database also enforces an hourly save limit. */
export class BuybackRequestLimiter {
  private windows = new Map<string, { startsAt: number; count: number }>();
  constructor(private readonly clock: () => number = Date.now) {}
  take(key: string, maximum: number, windowMs = 60_000) {
    const now = this.clock();
    for (const [entryKey, entry] of this.windows) if (now - entry.startsAt >= windowMs) this.windows.delete(entryKey);
    const saved = this.windows.get(key);
    if ((saved?.count ?? 0) >= maximum || (!saved && this.windows.size >= 5000)) {
      throw new BuybackError(429, "BUYBACK_RATE_LIMIT", "操作过于频繁，请稍后重试。");
    }
    this.windows.set(key, { startsAt: saved?.startsAt ?? now, count: (saved?.count ?? 0) + 1 });
  }
}

export function createBuybackService(dependencies: BuybackServiceDependencies) {
  const database = dependencies.database;
  const pendingUsers = new Set<number>();
  const limiter = new BuybackRequestLimiter();

  // Lock an existing corporation row rather than a lazily-created settings row.
  // This serializes first setup, every edit and final quote save, without writes
  // during GET. No external market request is made while holding this lock.
  async function lockConfiguration(tx: Transaction, corporationId: number) {
    const rows = await tx.select({ id: corporationsTable.id }).from(corporationsTable)
      .where(eq(corporationsTable.id, corporationId)).for("update");
    if (!rows.length) throw new BuybackError(403, "BUYBACK_CORPORATION_REQUIRED", "无法获取当前军团。");
  }

  async function readConfiguration(tx: Transaction, corporationId: number) {
    const [row] = await tx.select().from(buybackSettingsTable).where(eq(buybackSettingsTable.corporationId, corporationId));
    const rules = await tx.select().from(buybackRulesTable).where(eq(buybackRulesTable.corporationId, corporationId))
      .orderBy(asc(buybackRulesTable.scope), asc(buybackRulesTable.targetName), asc(buybackRulesTable.id));
    return { settings: settingsView(row), rules: rules.map(ruleView) };
  }

  async function getConfiguration(corporationId: number) {
    return database.transaction(async (tx) => {
      await lockConfiguration(tx, corporationId);
      return readConfiguration(tx, corporationId);
    });
  }

  async function saveConfiguration(tx: Transaction, actor: BuybackActor, settings: BuybackSettings) {
    if (settings.version >= 2_147_483_646) throw new BuybackError(409, "BUYBACK_VERSION_LIMIT", "设置版本已达到上限，请联系网站维护人员。");
    const values = {
      ...settings, corporationId: actor.corporationId, ratePercent: settings.ratePercent.toFixed(2),
      updatedBy: actor.userId, updatedAt: new Date(), version: settings.version + 1,
    };
    await tx.insert(buybackSettingsTable).values(values).onConflictDoUpdate({ target: buybackSettingsTable.corporationId, set: values });
  }

  async function saveSettings(actor: BuybackActor, body: unknown) {
    assertAdmin(actor);
    const input = validateBuybackSettings(body);
    return database.transaction(async (tx) => {
      await lockConfiguration(tx, actor.corporationId);
      const current = await readConfiguration(tx, actor.corporationId);
      assertVersion(input.version, current.settings.version);
      await saveConfiguration(tx, actor, input);
      return readConfiguration(tx, actor.corporationId);
    });
  }

  async function writeRule(actor: BuybackActor, body: unknown, id?: number) {
    assertAdmin(actor);
    const input = validateBuybackRule(body);
    const version = (body as { version?: unknown }).version;
    const target = await dependencies.getTarget(input.scope, input.targetId);
    if (!target) throw new BuybackError(400, "UNKNOWN_BUYBACK_TARGET", "找不到该物品或类别，请从搜索结果中选择。");
    return database.transaction(async (tx) => {
      await lockConfiguration(tx, actor.corporationId);
      const current = await readConfiguration(tx, actor.corporationId);
      assertVersion(version, current.settings.version);
      if (id === undefined && current.rules.length >= 2000) throw new BuybackError(400, "BUYBACK_RULE_LIMIT", "最多支持 2000 条规则，请优先使用类别规则。");
      const values = {
        ...input, corporationId: actor.corporationId, targetName: target.name,
        ratePercent: input.ratePercent === null ? null : input.ratePercent.toFixed(2), updatedBy: actor.userId, updatedAt: new Date(),
      };
      if (id === undefined) await tx.insert(buybackRulesTable).values(values);
      else {
        const rows = await tx.update(buybackRulesTable).set(values)
          .where(and(eq(buybackRulesTable.id, id), eq(buybackRulesTable.corporationId, actor.corporationId))).returning({ id: buybackRulesTable.id });
        if (!rows.length) throw new BuybackError(404, "BUYBACK_RULE_NOT_FOUND", "规则不存在。");
      }
      await saveConfiguration(tx, actor, current.settings);
      return readConfiguration(tx, actor.corporationId);
    });
  }

  async function deleteRule(actor: BuybackActor, id: number, version: unknown) {
    assertAdmin(actor);
    return database.transaction(async (tx) => {
      await lockConfiguration(tx, actor.corporationId);
      const current = await readConfiguration(tx, actor.corporationId);
      assertVersion(version, current.settings.version);
      const rows = await tx.delete(buybackRulesTable).where(and(eq(buybackRulesTable.id, id), eq(buybackRulesTable.corporationId, actor.corporationId)))
        .returning({ id: buybackRulesTable.id });
      if (!rows.length) throw new BuybackError(404, "BUYBACK_RULE_NOT_FOUND", "规则不存在。");
      await saveConfiguration(tx, actor, current.settings);
      return readConfiguration(tx, actor.corporationId);
    });
  }

  async function listQuotes(actor: BuybackActor, admin = false) {
    if (admin) assertAdmin(actor);
    const quotes = await database.select().from(buybackQuotesTable).where(and(
      eq(buybackQuotesTable.corporationId, actor.corporationId),
      admin ? undefined : eq(buybackQuotesTable.submittedBy, actor.userId),
    )).orderBy(desc(buybackQuotesTable.createdAt), desc(buybackQuotesTable.id)).limit(admin ? 100 : 50);
    return quotes.map(quoteView);
  }

  async function findRequest(tx: Transaction | Database, actor: BuybackActor, requestId: string, inputText: string) {
    const [existing] = await tx.select().from(buybackQuotesTable).where(and(
      eq(buybackQuotesTable.corporationId, actor.corporationId), eq(buybackQuotesTable.submittedBy, actor.userId), eq(buybackQuotesTable.requestId, requestId),
    ));
    if (existing && existing.inputText !== inputText) throw new BuybackError(409, "BUYBACK_REQUEST_CONFLICT", "该请求编号已用于另一份清单，请重新发起报价。");
    return existing;
  }

  async function createQuote(actor: BuybackActor, body: { text?: unknown; requestId?: unknown } | null | undefined) {
    const inputs = parseBuybackClipboard(body?.text);
    const text = body!.text as string;
    const requestId = body?.requestId ?? randomUUID();
    if (typeof requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(requestId)) throw new BuybackError(400, "INVALID_BUYBACK_REQUEST", "报价请求编号无效，请刷新页面。");
    const existing = await findRequest(database, actor, requestId, text);
    if (existing) return quoteView(existing);
    if (pendingUsers.has(actor.userId)) throw new BuybackError(429, "BUYBACK_QUOTE_IN_PROGRESS", "上一份报价仍在计算，请稍候。");
    if (pendingUsers.size >= 8) throw new BuybackError(429, "BUYBACK_BUSY", "报价服务繁忙，请稍后重试。");
    limiter.take(`quote:${actor.userId}`, 6);
    pendingUsers.add(actor.userId);
    try {
      const configuration = await getConfiguration(actor.corporationId);
      if (!configuration.settings.enabled) throw new BuybackError(409, "BUYBACK_CLOSED", "回收计算器暂未开放，请联系管理员。");
      const names = [...new Set(inputs.filter((input) => !input.error).map((input) => input.inputName))];
      if (names.length > 80) throw new BuybackError(400, "BUYBACK_TYPE_LIMIT", "每份报价最多 80 种不同物品，请拆分清单。");
      const types = await dependencies.resolveTypes(names);
      const marketTypeIds = [...new Set([...types.values()].filter((type) => {
        const rule = effectiveBuybackRule(configuration.settings, configuration.rules, type);
        return rule.enabled && rule.priceBasis !== "fixed" && type.marketGroupId !== null && type.categoryId !== 9;
      }).map((type) => type.typeId))];
      const prices = await dependencies.getPrices(marketTypeIds);
      const calculation = calculateBuybackQuote(inputs, configuration.settings, configuration.rules, types, prices);
      const typeIds = new Set([...types.values()].map(type => type.typeId));
      const categoryIds = new Set([...types.values()].map(type => type.categoryId));
      const rulesSnapshot = configuration.rules.filter(rule => (rule.scope === "type" ? typeIds : categoryIds).has(rule.targetId));
      const quote = await database.transaction(async (tx) => {
        await lockConfiguration(tx, actor.corporationId);
        const duplicate = await findRequest(tx, actor, requestId, text);
        if (duplicate) return duplicate;
        const current = await readConfiguration(tx, actor.corporationId);
        assertVersion(configuration.settings.version, current.settings.version);
        if (!current.settings.enabled) throw new BuybackError(409, "BUYBACK_CLOSED", "回收计算器已暂停，请联系管理员。");
        const createdAt = new Date();
        const [recent] = await tx.select({ count: sql<number>`count(*)::integer` }).from(buybackQuotesTable).where(and(
          eq(buybackQuotesTable.corporationId, actor.corporationId), eq(buybackQuotesTable.submittedBy, actor.userId),
          gte(buybackQuotesTable.createdAt, new Date(createdAt.getTime() - 3_600_000)),
        ));
        if ((recent?.count ?? 0) >= 60) throw new BuybackError(429, "BUYBACK_HOURLY_LIMIT", "每小时最多保存 60 份报价，请稍后重试。");
        const [created] = await tx.insert(buybackQuotesTable).values({
          corporationId: actor.corporationId, submittedBy: actor.userId, submitterName: actor.userName,
          inputText: text, requestId, ...calculation, settingsVersion: configuration.settings.version,
          settingsSnapshot: configuration.settings, rulesSnapshot, createdAt,
          expiresAt: new Date(createdAt.getTime() + configuration.settings.quoteValidityMinutes * 60_000),
        }).returning();
        return created!;
      });
      return quoteView(quote);
    } finally { pendingUsers.delete(actor.userId); }
  }

  return { getConfiguration, saveSettings, writeRule, deleteRule, listQuotes, createQuote };
}
