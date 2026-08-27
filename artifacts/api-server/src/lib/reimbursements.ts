import { getFixedNpcBuyPrice } from "./npc-buyback-catalog";

const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";
const CHARACTER_LOSS_CACHE_TTL_MS = 15 * 60_000;
const VERIFIED_KILLMAIL_CACHE_TTL_MS = 60 * 60_000;
const LOSS_HISTORY_DAYS = 365;
const LOSS_HISTORY_MONTH_BUCKETS = 13;
const MAX_HISTORY_LOSSES = 100;
const ESI_VERIFY_CONCURRENCY = 6;
const ZKILL_REQUEST_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 12_000;
const JITA_PRICE_CACHE_TTL_MS = 15 * 60_000;
const INSURANCE_CACHE_TTL_MS = 6 * 60 * 60_000;
const MARKET_PRICE_CONCURRENCY = 6;
const THE_FORGE_REGION_ID = 10_000_002;
const JITA_4_4_STATION_ID = 60_003_760;
const USER_AGENT = "EVE-Corporation-Manager/1.0 https://zephyr-fleet-track-production.up.railway.app";

type ZkillEntry = {
  killmail_id: number;
  zkb?: { hash?: string; totalValue?: number };
};

export type KillmailItem = {
  item_type_id: number;
  flag?: number;
  quantity_destroyed?: number;
  quantity_dropped?: number;
  items?: KillmailItem[];
};

type EsiKillmail = {
  killmail_id: number;
  killmail_time: string;
  victim: {
    character_id?: number;
    ship_type_id: number;
    items?: KillmailItem[];
  };
};

type MarketOrder = {
  is_buy_order: boolean;
  location_id: number;
  price: number;
  volume_remain: number;
};

type InsurancePrice = {
  type_id: number;
  levels: Array<{ payout: number }>;
};

type JitaMidPrice = {
  value: number | null;
  hasTwoSidedMarket: boolean;
};

export type VerifiedKillmail = {
  killmailId: number;
  killmailHash: string;
  occurredAt: Date;
  victimCharacterId: number | null;
  shipTypeId: number;
  shipName: string;
  totalValue: number;
  victimItems: KillmailItem[];
};

export type ReimbursementReferencePricing = {
  jitaMidValue: number;
  maximumInsurancePayout: number;
  fixedNpcCargoValue: number;
  fixedNpcCargoDeductions: FixedNpcCargoDeduction[];
  fixedNpcCargoCalculatedAt: Date;
  referenceReimbursementAmount: number;
  referencePriceStatus: "calculated" | "partial" | "unavailable";
  referencePriceMissingTypeCount: number;
  referencePriceCalculatedAt: Date;
};

export type FixedNpcCargoDeduction = {
  typeId: number;
  itemName: string;
  quantity: number;
  unitPrice: number;
  totalValue: number;
};

export class KillmailValidationError extends Error {}
export class ReferencePricingError extends Error {}

const verifiedKillmailCache = new Map<number, { expiresAt: number; value: VerifiedKillmail }>();
const characterLossCache = new Map<number, { expiresAt: number; value: VerifiedKillmail[] }>();
const typeNameCache = new Map<number, string>();
const jitaMidPriceCache = new Map<number, { expiresAt: number; value: JitaMidPrice }>();
const jitaMidPriceRequests = new Map<number, Promise<JitaMidPrice>>();
let insurancePayoutCache: { expiresAt: number; value: Map<number, number> } | null = null;
let insurancePayoutRequest: Promise<Map<number, number>> | null = null;

function parseKillmailId(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/\/kill\/(\d+)/i) ?? trimmed.match(/killmail_id[=/](\d+)/i);
  return match ? Number(match[1]) : null;
}

async function fetchJson<T>(url: string, source: "zkill" | "esi"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: source === "zkill"
        ? { "Accept-Encoding": "gzip", Accept: "application/json", "User-Agent": USER_AGENT }
        : { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new KillmailValidationError(source === "zkill" ? "zKillboard 暂时无法连接，请稍后重试" : "EVE ESI 暂时无法连接，请稍后重试");
  }
  if (!response.ok) {
    throw new KillmailValidationError(source === "zkill" ? "zKillboard 暂时无法读取损失记录" : "EVE ESI 无法验证该击杀报告");
  }
  try {
    return await response.json() as T;
  } catch {
    throw new KillmailValidationError(source === "zkill" ? "zKillboard 返回了无效数据" : "EVE ESI 返回了无效数据");
  }
}

async function getTypeName(typeId: number): Promise<string> {
  const cached = typeNameCache.get(typeId);
  if (cached) return cached;
  try {
    const type = await fetchJson<{ name?: string }>(
      `${ESI_BASE}/universe/types/${typeId}/?datasource=tranquility&language=zh`,
      "esi",
    );
    const name = String(type.name ?? typeId);
    typeNameCache.set(typeId, name);
    return name;
  } catch {
    return String(typeId);
  }
}

async function fetchKillmailDetails(killmailId: number, hash: string): Promise<EsiKillmail> {
  const killmail = await fetchJson<EsiKillmail>(
    `${ESI_BASE}/killmails/${killmailId}/${hash}/?datasource=tranquility`,
    "esi",
  );
  if (killmail.killmail_id !== killmailId || !killmail.victim?.ship_type_id) {
    throw new KillmailValidationError("EVE ESI 返回的击杀报告不完整");
  }
  return killmail;
}

async function verifyZkillEntry(entry: ZkillEntry): Promise<VerifiedKillmail> {
  const killmailId = Number(entry.killmail_id);
  const hash = entry.zkb?.hash;
  if (!Number.isSafeInteger(killmailId) || !hash) {
    throw new KillmailValidationError("击杀报告缺少 ESI 验证信息");
  }
  const cached = verifiedKillmailCache.get(killmailId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const killmail = await fetchKillmailDetails(killmailId, hash);
  const verified = {
    killmailId,
    killmailHash: hash,
    occurredAt: new Date(killmail.killmail_time),
    victimCharacterId: killmail.victim.character_id ?? null,
    shipTypeId: killmail.victim.ship_type_id,
    shipName: await getTypeName(killmail.victim.ship_type_id),
    totalValue: Number(entry.zkb?.totalValue ?? 0),
    victimItems: killmail.victim.items ?? [],
  };
  if (Number.isNaN(verified.occurredAt.getTime())) {
    throw new KillmailValidationError("击杀报告的时间无效");
  }
  verifiedKillmailCache.set(killmailId, { expiresAt: Date.now() + VERIFIED_KILLMAIL_CACHE_TTL_MS, value: verified });
  return verified;
}

async function verifyLossEntries(entries: ZkillEntry[]): Promise<VerifiedKillmail[]> {
  const verified: Array<VerifiedKillmail | null> = Array.from({ length: entries.length }, () => null);
  let nextIndex = 0;
  const workerCount = Math.min(ESI_VERIFY_CONCURRENCY, entries.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        verified[index] = await verifyZkillEntry(entries[index]);
      } catch {
        // Ignore individual stale or inaccessible killmails while keeping the rest of the timeline usable.
      }
    }
  }));

  return verified.flatMap((loss) => loss ? [loss] : []);
}

function getLossHistoryMonths(now = new Date()): Array<{ year: number; month: number }> {
  return Array.from({ length: LOSS_HISTORY_MONTH_BUCKETS }, (_, offset) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  });
}

async function listZkillLossEntries(characterId: number): Promise<ZkillEntry[]> {
  const entriesById = new Map<number, ZkillEntry>();
  const months = getLossHistoryMonths();

  for (let index = 0; index < months.length && entriesById.size < MAX_HISTORY_LOSSES; index += 1) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, ZKILL_REQUEST_DELAY_MS));
    }
    const { year, month } = months[index];
    const monthlyEntries = await fetchJson<ZkillEntry[]>(
      `${ZKILL_BASE}/losses/characterID/${characterId}/year/${year}/month/${month}/page/1/`,
      "zkill",
    );
    if (!Array.isArray(monthlyEntries)) {
      throw new KillmailValidationError("zKillboard 返回了无效的损失列表");
    }
    for (const entry of monthlyEntries) {
      const killmailId = Number(entry.killmail_id);
      if (Number.isSafeInteger(killmailId) && entry.zkb?.hash && !entriesById.has(killmailId)) {
        entriesById.set(killmailId, entry);
      }
    }
  }

  return [...entriesById.values()].slice(0, MAX_HISTORY_LOSSES);
}

export async function listCharacterLosses(characterId: number): Promise<VerifiedKillmail[]> {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new KillmailValidationError("角色编号无效");
  }
  const cached = characterLossCache.get(characterId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const cutoffAt = Date.now() - LOSS_HISTORY_DAYS * 24 * 60 * 60_000;
  const losses = (await verifyLossEntries(await listZkillLossEntries(characterId)))
    .filter((loss) => loss.victimCharacterId === characterId)
    .filter((loss) => loss.occurredAt.getTime() >= cutoffAt)
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
  characterLossCache.set(characterId, { expiresAt: Date.now() + CHARACTER_LOSS_CACHE_TTL_MS, value: losses });
  return losses;
}

export async function verifyKillmail(value: string): Promise<VerifiedKillmail> {
  const killmailId = parseKillmailId(value);
  if (!killmailId || !Number.isSafeInteger(killmailId)) {
    throw new KillmailValidationError("请输入有效的 zKillboard 击杀报告链接或编号");
  }
  const cached = verifiedKillmailCache.get(killmailId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const entries = await fetchJson<ZkillEntry[]>(`${ZKILL_BASE}/killID/${killmailId}/`, "zkill");
  if (!Array.isArray(entries)) throw new KillmailValidationError("zKillboard 返回了无效的击杀报告");
  const entry = entries.find((candidate) => candidate.killmail_id === killmailId);
  if (!entry) throw new KillmailValidationError("无法从 zKillboard 验证该击杀报告");
  return verifyZkillEntry(entry);
}

async function fetchReferenceResponse(url: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ReferencePricingError("EVE ESI 市场或保险服务暂时无法连接，请稍后重试");
  }
  if (!response.ok) {
    throw new ReferencePricingError(`EVE ESI 暂时无法提供参考价格（HTTP ${response.status}）`);
  }
  return response;
}

async function parseReferenceJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T;
  } catch {
    throw new ReferencePricingError("EVE ESI 返回了无效的市场或保险数据");
  }
}

async function fetchJitaMidPrice(typeId: number): Promise<JitaMidPrice> {
  const baseUrl = `${ESI_BASE}/markets/${THE_FORGE_REGION_ID}/orders/?datasource=tranquility&order_type=all&type_id=${typeId}`;
  const firstResponse = await fetchReferenceResponse(`${baseUrl}&page=1`);
  const pageCountHeader = Number(firstResponse.headers.get("x-pages") ?? 1);
  const pageCount = Number.isSafeInteger(pageCountHeader) && pageCountHeader > 0 ? pageCountHeader : 1;
  const firstPage = await parseReferenceJson<MarketOrder[]>(firstResponse);
  const remainingPages = pageCount > 1
    ? await Promise.all(Array.from({ length: pageCount - 1 }, async (_, index) => (
      parseReferenceJson<MarketOrder[]>(await fetchReferenceResponse(`${baseUrl}&page=${index + 2}`))
    )))
    : [];
  const orders = [firstPage, ...remainingPages]
    .flat()
    .filter((order) => (
      order.location_id === JITA_4_4_STATION_ID
      && Number.isFinite(order.price)
      && order.price >= 0
      && order.volume_remain > 0
    ));
  let highestBuy: number | null = null;
  let lowestSell: number | null = null;
  for (const order of orders) {
    if (order.is_buy_order) {
      highestBuy = highestBuy === null ? order.price : Math.max(highestBuy, order.price);
    } else {
      lowestSell = lowestSell === null ? order.price : Math.min(lowestSell, order.price);
    }
  }
  if (highestBuy !== null && lowestSell !== null) {
    return { value: (highestBuy + lowestSell) / 2, hasTwoSidedMarket: true };
  }
  return { value: highestBuy ?? lowestSell, hasTwoSidedMarket: false };
}

async function getJitaMidPrice(typeId: number): Promise<JitaMidPrice> {
  const cached = jitaMidPriceCache.get(typeId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const pending = jitaMidPriceRequests.get(typeId);
  if (pending) return pending;

  const request = fetchJitaMidPrice(typeId)
    .then((value) => {
      jitaMidPriceCache.set(typeId, { expiresAt: Date.now() + JITA_PRICE_CACHE_TTL_MS, value });
      return value;
    })
    .finally(() => jitaMidPriceRequests.delete(typeId));
  jitaMidPriceRequests.set(typeId, request);
  return request;
}

async function getInsurancePayouts(): Promise<Map<number, number>> {
  if (insurancePayoutCache && insurancePayoutCache.expiresAt > Date.now()) {
    return insurancePayoutCache.value;
  }
  if (insurancePayoutRequest) return insurancePayoutRequest;

  insurancePayoutRequest = fetchReferenceResponse(`${ESI_BASE}/insurance/prices/?datasource=tranquility`)
    .then((response) => parseReferenceJson<InsurancePrice[]>(response))
    .then((prices) => {
      const payouts = new Map<number, number>();
      for (const price of prices) {
        const maximumPayout = Math.max(0, ...price.levels
          .map((level) => Number(level.payout))
          .filter((payout) => Number.isFinite(payout)));
        payouts.set(price.type_id, maximumPayout);
      }
      insurancePayoutCache = { expiresAt: Date.now() + INSURANCE_CACHE_TTL_MS, value: payouts };
      return payouts;
    })
    .finally(() => {
      insurancePayoutRequest = null;
    });
  return insurancePayoutRequest;
}

function collectLossTypeQuantities(shipTypeId: number, items: KillmailItem[]): Map<number, number> {
  const quantities = new Map<number, number>([[shipTypeId, 1]]);
  const visit = (item: KillmailItem): void => {
    const quantity = Number(item.quantity_destroyed ?? 0) + Number(item.quantity_dropped ?? 0);
    if (Number.isSafeInteger(item.item_type_id) && quantity > 0 && Number.isFinite(quantity)) {
      quantities.set(item.item_type_id, (quantities.get(item.item_type_id) ?? 0) + quantity);
    }
    for (const nested of item.items ?? []) visit(nested);
  };
  for (const item of items) visit(item);
  return quantities;
}

type FixedNpcCargoDeductionCandidate = Omit<FixedNpcCargoDeduction, "itemName">;

const REIMBURSABLE_CARGO_FLAGS = new Set([
  5, // Cargo
  155, // Fleet Hangar
]);

export function collectFixedNpcCargoDeductions(items: KillmailItem[]): FixedNpcCargoDeductionCandidate[] {
  const quantities = new Map<number, number>();
  const visit = (item: KillmailItem, insideCargo: boolean): void => {
    const isCargo = insideCargo || (item.flag !== undefined && REIMBURSABLE_CARGO_FLAGS.has(item.flag));
    const quantity = Number(item.quantity_destroyed ?? 0) + Number(item.quantity_dropped ?? 0);
    if (
      isCargo
      && Number.isSafeInteger(item.item_type_id)
      && Number.isSafeInteger(quantity)
      && quantity > 0
      && getFixedNpcBuyPrice(item.item_type_id) !== null
    ) {
      quantities.set(item.item_type_id, (quantities.get(item.item_type_id) ?? 0) + quantity);
    }
    for (const nested of item.items ?? []) visit(nested, isCargo);
  };
  for (const item of items) visit(item, false);

  return [...quantities.entries()].map(([typeId, quantity]) => {
    const unitPrice = getFixedNpcBuyPrice(typeId)!;
    return {
      typeId,
      quantity,
      unitPrice,
      totalValue: roundIsk(unitPrice * quantity),
    };
  });
}

function roundIsk(value: number): number {
  return Math.round(value * 100) / 100;
}

export function calculateReferenceReimbursementAmount(
  jitaMidValue: number,
  maximumInsurancePayout: number,
  fixedNpcCargoValue: number,
): number {
  return roundIsk(Math.max(0, jitaMidValue - maximumInsurancePayout - fixedNpcCargoValue));
}

export async function calculateReimbursementReference(input: {
  killmailId: number;
  killmailHash: string;
  shipTypeId: number;
  victimItems?: KillmailItem[];
}): Promise<ReimbursementReferencePricing> {
  let victimItems = input.victimItems;
  if (!victimItems) {
    const killmail = await fetchKillmailDetails(input.killmailId, input.killmailHash);
    if (killmail.victim.ship_type_id !== input.shipTypeId) {
      throw new ReferencePricingError("击杀报告中的舰船与补损记录不一致");
    }
    victimItems = killmail.victim.items ?? [];
  }
  const quantities = collectLossTypeQuantities(input.shipTypeId, victimItems);
  const fixedNpcCargoCandidates = collectFixedNpcCargoDeductions(victimItems);
  const fixedNpcCargoByType = new Map(fixedNpcCargoCandidates.map((item) => [item.typeId, item]));
  const typeIds = [...quantities.entries()].flatMap(([typeId, quantity]) => (
    quantity > (fixedNpcCargoByType.get(typeId)?.quantity ?? 0) ? [typeId] : []
  ));
  const prices = new Map<number, JitaMidPrice>();
  let nextIndex = 0;

  const [insurancePayouts, fixedNpcCargoDeductions] = await Promise.all([
    getInsurancePayouts(),
    Promise.all(fixedNpcCargoCandidates.map(async (item) => ({
      ...item,
      itemName: await getTypeName(item.typeId),
    }))),
    Promise.all(Array.from(
      { length: Math.min(MARKET_PRICE_CONCURRENCY, typeIds.length) },
      async () => {
        while (nextIndex < typeIds.length) {
          const index = nextIndex;
          nextIndex += 1;
          const typeId = typeIds[index];
          prices.set(typeId, await getJitaMidPrice(typeId));
        }
      },
    )),
  ]);

  let jitaMidValue = 0;
  let missingTypeCount = 0;
  let pricedTypeCount = 0;
  for (const [typeId, quantity] of quantities) {
    const fixedNpcCargo = fixedNpcCargoByType.get(typeId);
    const fixedNpcCargoQuantity = fixedNpcCargo?.quantity ?? 0;
    const marketQuantity = Math.max(0, quantity - fixedNpcCargoQuantity);
    let hasPrice = fixedNpcCargoQuantity > 0;

    if (fixedNpcCargo) {
      jitaMidValue += fixedNpcCargo.unitPrice * fixedNpcCargoQuantity;
    }
    if (marketQuantity > 0) {
      const quote = prices.get(typeId);
      if (!quote || quote.value === null) {
        missingTypeCount += 1;
      } else {
        hasPrice = true;
        if (!quote.hasTwoSidedMarket) missingTypeCount += 1;
        jitaMidValue += quote.value * marketQuantity;
      }
    }
    if (hasPrice) pricedTypeCount += 1;
  }
  const maximumInsurancePayout = insurancePayouts.get(input.shipTypeId) ?? 0;
  const status = pricedTypeCount === 0
    ? "unavailable"
    : missingTypeCount === 0
    ? "calculated"
    : "partial";
  const roundedJitaMidValue = roundIsk(jitaMidValue);
  const roundedInsurancePayout = roundIsk(maximumInsurancePayout);
  const fixedNpcCargoValue = roundIsk(fixedNpcCargoDeductions.reduce(
    (total, deduction) => total + deduction.totalValue,
    0,
  ));
  const calculatedAt = new Date();

  return {
    jitaMidValue: roundedJitaMidValue,
    maximumInsurancePayout: roundedInsurancePayout,
    fixedNpcCargoValue,
    fixedNpcCargoDeductions,
    fixedNpcCargoCalculatedAt: calculatedAt,
    referenceReimbursementAmount: calculateReferenceReimbursementAmount(
      roundedJitaMidValue,
      roundedInsurancePayout,
      fixedNpcCargoValue,
    ),
    referencePriceStatus: status,
    referencePriceMissingTypeCount: missingTypeCount,
    referencePriceCalculatedAt: calculatedAt,
  };
}
