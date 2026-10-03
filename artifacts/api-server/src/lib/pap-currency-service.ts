import { createHash } from "node:crypto";
import type { db } from "@workspace/db";
import { corporationMembershipsTable, corporationsTable, papCurrenciesTable, papCurrencyWalletsTable, papCurrencyLedgerTable, papLedgerTable, usersTable } from "@workspace/db/schema";
import { and, asc, desc, eq, ilike, inArray, or } from "drizzle-orm";
import { assertPapVersion, calculatePapConversion, commonPapUnits, formatPapUnits, MAX_PAP, MAX_PAP_RATE, PapCurrencyError, parsePapDecimal, validatePapRequestId } from "./pap-currency-math";

type Database = typeof db;
export type PapCurrencyTransaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type PapCurrencyActor = { corporationId: number; userId: number; userName: string; role: string };
type Currency = typeof papCurrenciesTable.$inferSelect;
type Wallet = typeof papCurrencyWalletsTable.$inferSelect;
type Entry = typeof papCurrencyLedgerTable.$inferSelect;

function positiveId(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new PapCurrencyError(400, "PAP_INVALID_ID", "PAP 种类或成员编号无效。");
  return Number(value);
}
function bodyObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PapCurrencyError(400, "PAP_INVALID_INPUT", "请求内容无效。");
  return value as Record<string, unknown>;
}
function assertAdmin(actor: PapCurrencyActor) {
  if (!["admin", "controller"].includes(actor.role)) throw new PapCurrencyError(403, "PAP_ADMIN_REQUIRED", "只有管理员或总监可以管理 PAP 种类与发放。");
}
function currencyView(currency: Currency) {
  return { id: currency.id, name: currency.name, description: currency.description, rate: currency.rate, issuanceEnabled: currency.issuanceEnabled, conversionEnabled: currency.conversionEnabled, version: currency.version, updatedAt: currency.updatedAt };
}
function walletView(wallet: Pick<Wallet, "currencyId" | "balance" | "carry" | "version">) {
  return { currencyId: wallet.currencyId, balance: wallet.balance, carry: wallet.carry, version: wallet.version };
}
function entryView(entry: Entry) {
  const { requestFingerprint: _fingerprint, corporationId: _corporation, ...view } = entry;
  return view;
}
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function currencyInput(value: unknown) {
  const body = bodyObject(value);
  const name = typeof body.name === "string" ? body.name.normalize("NFKC").trim().replace(/\s+/g, " ") : "";
  const normalizedName = name.toLocaleLowerCase("en-US");
  const description = typeof body.description === "string" ? body.description.trim() : "";
  if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name) || description.length > 1000 || ["通用pap", "通用 pap", "pap", "common pap"].includes(normalizedName)) {
    throw new PapCurrencyError(400, "PAP_INVALID_CURRENCY_NAME", "种类名称须为 1–40 字，不能使用通用 PAP 的保留名称；说明最多 1000 字。");
  }
  const rate = parsePapDecimal(body.rate, 6, false, MAX_PAP_RATE);
  if (!rate || typeof body.issuanceEnabled !== "boolean" || typeof body.conversionEnabled !== "boolean") throw new PapCurrencyError(400, "PAP_INVALID_CURRENCY", "请填写大于 0 的兑换比例及发放、兑换开关。");
  return { name, normalizedName, description, rate: formatPapUnits(rate), issuanceEnabled: body.issuanceEnabled, conversionEnabled: body.conversionEnabled };
}

async function lockCurrency(database: Database | PapCurrencyTransaction, corporationId: number, currencyId: number, lock = true) {
  const query = database.select().from(papCurrenciesTable).where(and(eq(papCurrenciesTable.corporationId, corporationId), eq(papCurrenciesTable.id, currencyId)));
  const [currency] = lock ? await query.for("update") : await query;
  if (!currency) throw new PapCurrencyError(404, "PAP_CURRENCY_NOT_FOUND", "找不到该 PAP 种类。");
  return currency;
}
export async function validateCurrencyForAward(database: Database | PapCurrencyTransaction, corporationId: number, currencyId: number, lock = false) {
  const currency = await lockCurrency(database, corporationId, positiveId(currencyId), lock);
  if (!currency.issuanceEnabled) throw new PapCurrencyError(409, "PAP_ISSUANCE_PAUSED", "该 PAP 种类已暂停发放。");
  return currency;
}
async function lockMember(tx: PapCurrencyTransaction, corporationId: number, userId: number) {
  const [user] = await tx.select().from(usersTable).where(eq(usersTable.id, userId)).for("update");
  const [membership] = await tx.select({ id: corporationMembershipsTable.id }).from(corporationMembershipsTable).where(and(eq(corporationMembershipsTable.corporationId, corporationId), eq(corporationMembershipsTable.userId, userId)));
  if (!user || !membership) throw new PapCurrencyError(404, "PAP_MEMBER_NOT_FOUND", "找不到本军团的该成员。");
  return user;
}
async function loadWallet(tx: PapCurrencyTransaction, corporationId: number, userId: number, currencyId: number) {
  const [wallet] = await tx.select().from(papCurrencyWalletsTable).where(and(eq(papCurrencyWalletsTable.corporationId, corporationId), eq(papCurrencyWalletsTable.userId, userId), eq(papCurrencyWalletsTable.currencyId, currencyId))).for("update");
  return wallet ?? { corporationId, userId, currencyId, balance: "0.000000", carry: "0.000000000000", version: 0 };
}
async function saveWallet(tx: PapCurrencyTransaction, wallet: Awaited<ReturnType<typeof loadWallet>>, balance: bigint, carry: bigint) {
  if (balance < 0n) throw new PapCurrencyError(400, "PAP_INSUFFICIENT_BALANCE", "该种类 PAP 余额不足。");
  if (balance > MAX_PAP) throw new PapCurrencyError(400, "PAP_AMOUNT_LIMIT", "该种类 PAP 余额不能超过 1,000,000,000。");
  if (wallet.version >= 2_147_483_646) throw new PapCurrencyError(409, "PAP_VERSION_LIMIT", "余额版本达到上限，请联系管理员。");
  const values = { corporationId: wallet.corporationId, userId: wallet.userId, currencyId: wallet.currencyId, balance: formatPapUnits(balance), carry: formatPapUnits(carry, 12), version: wallet.version + 1, updatedAt: new Date() };
  const [saved] = await tx.insert(papCurrencyWalletsTable).values(values).onConflictDoUpdate({ target: [papCurrencyWalletsTable.corporationId, papCurrencyWalletsTable.currencyId, papCurrencyWalletsTable.userId], set: values }).returning();
  return saved;
}
async function savedRequest(tx: PapCurrencyTransaction, corporationId: number, requestId: string, expected: string) {
  const [entry] = await tx.select().from(papCurrencyLedgerTable).where(and(eq(papCurrencyLedgerTable.corporationId, corporationId), eq(papCurrencyLedgerTable.requestId, requestId)));
  if (!entry) return null;
  if (entry.requestFingerprint !== expected) throw new PapCurrencyError(409, "PAP_REQUEST_CONFLICT", "该请求标识已用于其他操作，请刷新后重试。");
  return entry;
}

/** Used inside the fleet transaction: one kind of PAP only, never common PAP.
 * Callers must follow the currency -> user -> wallet locking order. */
export async function awardCustomPap(tx: PapCurrencyTransaction, input: {
  corporationId: number; userId: number; userName: string; currencyId: number; amount: number | string; reason: string; fleetId?: number; characterId?: number; adminId?: number;
}) {
  const amount = parsePapDecimal(typeof input.amount === "number" ? String(input.amount) : input.amount);
  if (amount <= 0n) throw new PapCurrencyError(400, "PAP_INVALID_AMOUNT", "发放数量必须大于 0。");
  const currency = await validateCurrencyForAward(tx, input.corporationId, input.currencyId, true);
  await lockMember(tx, input.corporationId, input.userId);
  const wallet = await loadWallet(tx, input.corporationId, input.userId, input.currencyId);
  const saved = await saveWallet(tx, wallet, parsePapDecimal(wallet.balance) + amount, parsePapDecimal(wallet.carry, 12));
  const [entry] = await tx.insert(papCurrencyLedgerTable).values({
    corporationId: input.corporationId, currencyId: currency.id, currencyName: currency.name, currencyVersion: currency.version,
    userId: input.userId, userName: input.userName, type: "award", amount: formatPapUnits(amount), balanceBefore: wallet.balance, balanceAfter: saved.balance,
    carryBefore: wallet.carry, carryAfter: saved.carry, reason: input.reason, fleetId: input.fleetId, characterId: input.characterId, adminId: input.adminId,
  }).returning();
  return { currency, wallet: saved, entry };
}

export function createPapCurrencyService({ database }: { database: Database }) {
  const listCurrencies = async (corporationId: number) => (await database.select().from(papCurrenciesTable).where(eq(papCurrenciesTable.corporationId, corporationId)).orderBy(asc(papCurrenciesTable.id))).map(currencyView);
  const listEntries = async (actor: PapCurrencyActor, all = false) => {
    if (all) assertAdmin(actor);
    return (await database.select().from(papCurrencyLedgerTable).where(and(eq(papCurrencyLedgerTable.corporationId, actor.corporationId), all ? undefined : eq(papCurrencyLedgerTable.userId, actor.userId))).orderBy(desc(papCurrencyLedgerTable.id)).limit(all ? 200 : 100)).map(entryView);
  };
  async function getWallet(actor: PapCurrencyActor) {
    const [user] = await database.select().from(usersTable).where(eq(usersTable.id, actor.userId));
    if (!user) throw new PapCurrencyError(404, "PAP_MEMBER_NOT_FOUND", "找不到成员。");
    const balance = commonPapUnits(user.redeemablePap), locked = commonPapUnits(user.lockedPap);
    const wallets = await database.select().from(papCurrencyWalletsTable).where(and(eq(papCurrencyWalletsTable.corporationId, actor.corporationId), eq(papCurrencyWalletsTable.userId, actor.userId)));
    return { common: { balance: formatPapUnits(balance), locked: formatPapUnits(locked), available: formatPapUnits(balance > locked ? balance - locked : 0n) }, wallets: wallets.map(walletView), currencies: await listCurrencies(actor.corporationId), entries: await listEntries(actor) };
  }
  async function createCurrency(actor: PapCurrencyActor, body: unknown) {
    assertAdmin(actor);
    const input = currencyInput(body), requestId = validatePapRequestId(bodyObject(body).requestId);
    return database.transaction(async tx => {
      await tx.select({ id: corporationsTable.id }).from(corporationsTable).where(eq(corporationsTable.id, actor.corporationId)).for("update");
      const current = await tx.select().from(papCurrenciesTable).where(eq(papCurrenciesTable.corporationId, actor.corporationId));
      const replay = current.find(item => item.createRequestId === requestId);
      if (replay) {
        if (Object.entries(input).some(([key, value]) => replay[key as keyof Currency] !== value)) throw new PapCurrencyError(409, "PAP_REQUEST_CONFLICT", "该创建请求已经使用，请刷新查看已有种类。");
        return { currency: currencyView(replay), replayed: true };
      }
      if (current.length >= 100) throw new PapCurrencyError(400, "PAP_CURRENCY_LIMIT", "最多支持 100 种自定义 PAP。");
      if (current.some(item => item.normalizedName === input.normalizedName)) throw new PapCurrencyError(409, "PAP_CURRENCY_NAME_EXISTS", "已经存在同名 PAP 种类。");
      const [currency] = await tx.insert(papCurrenciesTable).values({ ...input, corporationId: actor.corporationId, createRequestId: requestId, createdBy: actor.userId, updatedBy: actor.userId }).returning();
      return { currency: currencyView(currency), replayed: false };
    });
  }
  async function editCurrency(actor: PapCurrencyActor, id: number, body: unknown) {
    assertAdmin(actor);
    const input = currencyInput(body);
    return database.transaction(async tx => {
      const current = await lockCurrency(tx, actor.corporationId, positiveId(id));
      assertPapVersion(bodyObject(body).version, current.version);
      const [currency] = await tx.update(papCurrenciesTable).set({ ...input, version: current.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(papCurrenciesTable.id, id)).returning();
      return { currency: currencyView(currency) };
    });
  }
  function conversionInput(body: unknown) {
    const input = bodyObject(body);
    if ("targetCurrencyId" in input || "toCurrencyId" in input || "target" in input) throw new PapCurrencyError(400, "PAP_ONE_WAY_ONLY", "自定义 PAP 只能兑换为通用 PAP。");
    const amount = parsePapDecimal(input.amount);
    if (amount <= 0n) throw new PapCurrencyError(400, "PAP_INVALID_AMOUNT", "兑换数量必须大于 0。");
    return { body: input, currencyId: positiveId(input.currencyId), amount, amountText: formatPapUnits(amount) };
  }
  async function prepareConversion(tx: PapCurrencyTransaction, actor: PapCurrencyActor, input: ReturnType<typeof conversionInput>, currency: Currency) {
    if (!currency.conversionEnabled) throw new PapCurrencyError(409, "PAP_CONVERSION_PAUSED", "该 PAP 种类已暂停兑换。");
    const user = await lockMember(tx, actor.corporationId, actor.userId);
    const wallet = await loadWallet(tx, actor.corporationId, actor.userId, currency.id);
    const balanceAfter = parsePapDecimal(wallet.balance) - input.amount;
    if (balanceAfter < 0n) throw new PapCurrencyError(400, "PAP_INSUFFICIENT_BALANCE", "该种类 PAP 余额不足。");
    const result = calculatePapConversion(input.amount, parsePapDecimal(currency.rate, 6, false, MAX_PAP_RATE), parsePapDecimal(wallet.carry, 12));
    const commonBefore = commonPapUnits(user.redeemablePap), commonAfter = commonBefore + result.commonAmount;
    const commonLocked = commonPapUnits(user.lockedPap);
    if (commonAfter > MAX_PAP || commonLocked > commonBefore) throw new PapCurrencyError(409, "PAP_COMMON_BALANCE_LIMIT", "通用 PAP 余额超出支持范围，请联系管理员。");
    return { user, wallet, balanceAfter, ...result, commonBefore, commonAfter, commonLocked };
  }
  async function preview(actor: PapCurrencyActor, body: unknown) {
    const input = conversionInput(body);
    return database.transaction(async tx => {
      const currency = await lockCurrency(tx, actor.corporationId, input.currencyId);
      const result = await prepareConversion(tx, actor, input, currency);
      return { currencyId: currency.id, currencyName: currency.name, amount: input.amountText, rate: currency.rate, commonAmount: formatPapUnits(result.commonAmount), carryBefore: result.wallet.carry, carryAfter: formatPapUnits(result.carryAfter, 12), balanceAfter: formatPapUnits(result.balanceAfter), version: currency.version, walletVersion: result.wallet.version };
    });
  }
  async function convert(actor: PapCurrencyActor, body: unknown) {
    const input = conversionInput(body), requestId = validatePapRequestId(input.body.requestId);
    const signature = fingerprint({ type: "conversion", actor: actor.userId, currencyId: input.currencyId, amount: input.amountText, version: input.body.version, walletVersion: input.body.walletVersion });
    return database.transaction(async tx => {
      const currency = await lockCurrency(tx, actor.corporationId, input.currencyId);
      const replay = await savedRequest(tx, actor.corporationId, requestId, signature);
      if (replay) return { entry: entryView(replay), replayed: true };
      assertPapVersion(input.body.version, currency.version);
      const result = await prepareConversion(tx, actor, input, currency);
      assertPapVersion(input.body.walletVersion, result.wallet.version, true);
      const wallet = await saveWallet(tx, result.wallet, result.balanceAfter, result.carryAfter);
      // The old balance field is a compatibility mirror, not lifetime earnings.
      await tx.update(usersTable).set({ redeemablePap: Number(formatPapUnits(result.commonAfter)), totalPap: Number(formatPapUnits(result.commonAfter)), updatedAt: new Date() }).where(eq(usersTable.id, actor.userId));
      const [entry] = await tx.insert(papCurrencyLedgerTable).values({
        corporationId: actor.corporationId, currencyId: currency.id, currencyName: currency.name, currencyVersion: currency.version,
        userId: actor.userId, userName: actor.userName, type: "conversion", amount: formatPapUnits(-input.amount), rate: currency.rate, commonAmount: formatPapUnits(result.commonAmount),
        balanceBefore: result.wallet.balance, balanceAfter: wallet.balance, carryBefore: result.wallet.carry, carryAfter: wallet.carry,
        commonBalanceBefore: formatPapUnits(result.commonBefore), commonBalanceAfter: formatPapUnits(result.commonAfter), requestId, requestFingerprint: signature,
        reason: `${input.amountText} ${currency.name} → ${formatPapUnits(result.commonAmount)} 通用 PAP`,
      }).returning();
      await tx.insert(papLedgerTable).values({ corporationId: actor.corporationId, userId: actor.userId, userName: actor.userName, type: "pap_conversion", amount: Number(formatPapUnits(result.commonAmount)), lockedDelta: 0, balanceAfter: Number(formatPapUnits(result.commonAfter)), lockedAfter: Number(formatPapUnits(result.commonLocked)), availableAfter: Number(formatPapUnits(result.commonAfter - result.commonLocked)), reason: `兑换流水 #${entry.id}：${entry.reason}` });
      return { entry: entryView(entry), replayed: false };
    });
  }
  async function adjust(actor: PapCurrencyActor, body: unknown) {
    assertAdmin(actor);
    const input = bodyObject(body), currencyId = positiveId(input.currencyId), userId = positiveId(input.userId);
    const amount = parsePapDecimal(input.amount, 6, true), requestId = validatePapRequestId(input.requestId);
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (amount === 0n || !reason || reason.length > 500) throw new PapCurrencyError(400, "PAP_INVALID_ADJUSTMENT", "请输入非零调整数量及 1–500 字的原因。");
    const signature = fingerprint({ type: "adjustment", actor: actor.userId, userId, currencyId, amount: formatPapUnits(amount), reason, version: input.version });
    return database.transaction(async tx => {
      const currency = await lockCurrency(tx, actor.corporationId, currencyId);
      const replay = await savedRequest(tx, actor.corporationId, requestId, signature);
      if (replay) return { entry: entryView(replay), replayed: true };
      assertPapVersion(input.version, currency.version);
      if (amount > 0n && !currency.issuanceEnabled) throw new PapCurrencyError(409, "PAP_ISSUANCE_PAUSED", "该种类已暂停发放，无法增加余额。");
      const user = await lockMember(tx, actor.corporationId, userId), before = await loadWallet(tx, actor.corporationId, userId, currencyId);
      const wallet = await saveWallet(tx, before, parsePapDecimal(before.balance) + amount, parsePapDecimal(before.carry, 12));
      const [entry] = await tx.insert(papCurrencyLedgerTable).values({ corporationId: actor.corporationId, currencyId, currencyName: currency.name, currencyVersion: currency.version,
        userId, userName: user.eveCharacterName ?? `成员 ${userId}`, type: "adjustment", amount: formatPapUnits(amount), balanceBefore: before.balance, balanceAfter: wallet.balance,
        carryBefore: before.carry, carryAfter: wallet.carry, requestId, requestFingerprint: signature, reason, adminId: actor.userId,
      }).returning();
      return { entry: entryView(entry), replayed: false };
    });
  }
  async function members(actor: PapCurrencyActor, query: string) {
    assertAdmin(actor);
    if (query.length > 80) throw new PapCurrencyError(400, "PAP_INVALID_SEARCH", "搜索内容过长。");
    const safeQuery = query.replace(/[\\%_]/g, "\\$&");
    const selected = await database.select({ id: usersTable.id, name: usersTable.eveCharacterName }).from(usersTable).innerJoin(corporationMembershipsTable, and(eq(corporationMembershipsTable.userId, usersTable.id), eq(corporationMembershipsTable.corporationId, actor.corporationId)))
      .where(query ? or(ilike(usersTable.eveCharacterName, `%${safeQuery}%`), /^\d+$/.test(query) && Number.isSafeInteger(Number(query)) ? eq(usersTable.id, Number(query)) : undefined) : undefined).orderBy(asc(usersTable.id)).limit(50);
    const wallets = selected.length ? await database.select().from(papCurrencyWalletsTable).where(and(eq(papCurrencyWalletsTable.corporationId, actor.corporationId), inArray(papCurrencyWalletsTable.userId, selected.map(user => user.id)))) : [];
    return { members: selected.map(user => ({ id: user.id, name: user.name ?? `成员 ${user.id}`, wallets: wallets.filter(wallet => wallet.userId === user.id).map(walletView) })) };
  }
  return { listCurrencies, listEntries, getWallet, createCurrency, editCurrency, preview, convert, adjust, members };
}
