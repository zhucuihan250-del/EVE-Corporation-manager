import { summarizeBuybackOrders, type BuybackMarketOrder } from "./buyback-market";
import type { CanonicalFit } from "./fitting-engine-types";
import type { FittingAdvicePrice } from "./fitting-advice-types";

export const FITTING_ADVICE_PRICE_LIMITS = Object.freeze({
  fits: 3, types: 80, pages: 30, concurrency: 4, queued: 128,
  deadlineMs: 10_000, cacheMs: 5 * 60_000, cacheEntries: 5000,
  pageBytes: 1024 * 1024, pageOrders: 1000,
});
const BASE_NOTE = "Jita 4-4 最低卖单估价（最多 5 分钟缓存），不是市场深度报价或保证成交价。计入船体、每件装备、已指定装填弹药、全部携带无人机、货舱和配置包含的植入体/增效剂；弹药数量未指定时按 1 发，仅计算指定弹药，不估算额外补给。";
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
type Options = { signal?: AbortSignal };
type Dependencies = { fetch?: typeof globalThis.fetch; now?: () => number; deadlineMs?: number; cacheEntries?: number };
type Price = { cents: bigint | null; checkedAt: number };
type Bill = { quantities: Map<number, bigint>; invalidTypeIds: Set<number>; invalid: boolean };
type Waiter = { signal: AbortSignal; resolve: (release: () => void) => void; reject: (error: Error) => void; abort: () => void };

// Shared by all quote batches and quote-service instances in this process:
// at most four requests, including body reads, are active. This limiter does
// not cover other ESI features, buyback requests or other server processes.
let active = 0;
const queue: Waiter[] = [];
class MarketRateLimited extends Error {}
const cancelled = () => new Error("Fitting price request cancelled");
function releasePermit() {
  active--;
  while (queue.length && active < FITTING_ADVICE_PRICE_LIMITS.concurrency) {
    const next = queue.shift()!;
    next.signal.removeEventListener("abort", next.abort);
    if (next.signal.aborted) { next.reject(cancelled()); continue; }
    active++;
    let released = false;
    next.resolve(() => { if (!released) { released = true; releasePermit(); } });
  }
}
function permit(signal: AbortSignal): Promise<() => void> {
  if (signal.aborted) return Promise.reject(cancelled());
  if (active < FITTING_ADVICE_PRICE_LIMITS.concurrency) {
    active++;
    let released = false;
    return Promise.resolve(() => { if (!released) { released = true; releasePermit(); } });
  }
  if (queue.length >= FITTING_ADVICE_PRICE_LIMITS.queued) return Promise.reject(new Error("Fitting price queue full"));
  return new Promise((resolve, reject) => {
    const waiter: Waiter = { signal, resolve, reject, abort: () => {
      const index = queue.indexOf(waiter);
      if (index >= 0) queue.splice(index, 1);
      reject(cancelled());
    } };
    signal.addEventListener("abort", waiter.abort, { once: true });
    queue.push(waiter);
    if (signal.aborted) waiter.abort();
  });
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(cancelled()); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => { signal.removeEventListener("abort", abort); if (signal.aborted) reject(cancelled()); else resolve(value); }, () => { signal.removeEventListener("abort", abort); reject(new Error("Fitting market unavailable")); });
    if (signal.aborted) abort();
  });
}
const validId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2_147_483_647;
function collect(fit: CanonicalFit): Bill {
  const bill: Bill = { quantities: new Map(), invalidTypeIds: new Set(), invalid: false };
  const add = (id: unknown, quantity: unknown) => {
    if (!validId(id)) { bill.invalid = true; return; }
    if (!Number.isSafeInteger(quantity) || Number(quantity) <= 0) { bill.invalid = true; bill.invalidTypeIds.add(id); return; }
    const total = (bill.quantities.get(id) ?? 0n) + BigInt(Number(quantity));
    if (total > MAX_SAFE) { bill.invalid = true; bill.invalidTypeIds.add(id); return; }
    bill.quantities.set(id, total);
  };
  if (!fit || typeof fit !== "object") { bill.invalid = true; return bill; }
  add(fit.shipTypeId, 1);
  const bounded = <T>(list: T[] | undefined, optional = false): T[] => {
    if (list === undefined && optional) return [];
    if (!Array.isArray(list) || list.length > 256) { bill.invalid = true; return []; }
    return list;
  };
  for (const slot of bounded(fit.slots)) {
    if (!slot || typeof slot !== "object") { bill.invalid = true; continue; }
    add(slot.typeId, 1);
    if (slot.chargeTypeId !== undefined) add(slot.chargeTypeId, slot.chargeQuantity === undefined ? 1 : slot.chargeQuantity);
    else if (slot.chargeQuantity !== undefined) bill.invalid = true;
  }
  for (const drone of bounded(fit.drones)) if (drone && typeof drone === "object") add(drone.typeId, drone.quantity); else bill.invalid = true;
  for (const cargo of bounded(fit.cargo)) if (cargo && typeof cargo === "object") add(cargo.typeId, cargo.quantity); else bill.invalid = true;
  for (const implant of bounded(fit.implants, true)) if (implant && typeof implant === "object") add(implant.typeId, 1); else bill.invalid = true;
  for (const booster of bounded(fit.boosters, true)) if (booster && typeof booster === "object") add(booster.typeId, 1); else bill.invalid = true;
  return bill;
}
function cents(value: string | null): bigint | null {
  if (!value || !/^\d{1,14}\.\d{2}$/.test(value)) return null;
  const parsed = BigInt(value.replace(".", ""));
  return parsed > 0n && parsed <= MAX_SAFE ? parsed : null;
}
async function readOrders(response: Response, signal: AbortSignal, typeId: number): Promise<BuybackMarketOrder[]> {
  const length = response.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > FITTING_ADVICE_PRICE_LIMITS.pageBytes)) { void response.body?.cancel().catch(() => {}); throw new Error("Fitting market body too large"); }
  if (!response.body) throw new Error("Fitting market body missing");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > FITTING_ADVICE_PRICE_LIMITS.pageBytes) { abort(); throw new Error("Fitting market body too large"); }
      chunks.push(part.value);
    }
    if (signal.aborted) throw cancelled();
    const merged = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(merged));
    if (!Array.isArray(value) || value.length > FITTING_ADVICE_PRICE_LIMITS.pageOrders) throw new Error("Fitting market page incomplete");
    if (!value.every(order => order && typeof order === "object" && order.type_id === typeId && Number.isSafeInteger(order.location_id) && order.location_id > 0 && typeof order.is_buy_order === "boolean" && Number.isFinite(order.price) && order.price > 0 && order.price <= 1e13 && Number.isSafeInteger(order.volume_remain) && order.volume_remain >= 0)) throw new Error("Fitting market order invalid");
    return value as BuybackMarketOrder[];
  } finally {
    signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { abort(); }
  }
}

/** Tests may supply a shorter deadline; production always caps it at 10 s.
 * A caller abort cancels queued permits and active fetch/body streams. */
export function createFittingAdvicePriceService(dependencies: Dependencies = {}) {
  const request = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const deadlineMs = Number.isSafeInteger(dependencies.deadlineMs) && dependencies.deadlineMs! > 0 ? Math.min(FITTING_ADVICE_PRICE_LIMITS.deadlineMs, dependencies.deadlineMs!) : FITTING_ADVICE_PRICE_LIMITS.deadlineMs;
  const maxCache = Number.isSafeInteger(dependencies.cacheEntries) && dependencies.cacheEntries! > 0 ? Math.min(FITTING_ADVICE_PRICE_LIMITS.cacheEntries, dependencies.cacheEntries!) : FITTING_ADVICE_PRICE_LIMITS.cacheEntries;
  const cache = new Map<number, Price & { expiresAt: number }>();
  const clock = () => { const value = now(); return Number.isFinite(value) && value >= 0 && value <= 8.64e15 ? value : Date.now(); };
  function remember(id: number, value: Price) {
    cache.delete(id);
    while (cache.size >= maxCache) cache.delete(cache.keys().next().value!);
    cache.set(id, { ...value, expiresAt: value.checkedAt + FITTING_ADVICE_PRICE_LIMITS.cacheMs });
  }
  async function page(typeId: number, number: number, signal: AbortSignal) {
    const release = await permit(signal);
    try {
      if (signal.aborted) throw cancelled();
      const response = await abortable(request(`https://esi.evetech.net/latest/markets/10000002/orders/?datasource=tranquility&order_type=all&type_id=${typeId}&page=${number}`, {
        method: "GET", redirect: "error", headers: { Accept: "application/json", "User-Agent": "EVE-Corporation-Manager/1.0 fitting-advice-prices" }, signal,
      }), signal);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 420 || response.status === 429) throw new MarketRateLimited("Fitting market rate limited");
        throw new Error("Fitting market unavailable");
      }
      const raw = response.headers.get("x-pages");
      if (!raw || !/^[1-9]\d?$/.test(raw) || Number(raw) > FITTING_ADVICE_PRICE_LIMITS.pages) { void response.body?.cancel().catch(() => {}); throw new Error("Fitting market pages incomplete"); }
      const orders = await readOrders(response, signal, typeId);
      if (Number(raw) > 1 && orders.length === 0) throw new Error("Fitting market page incomplete");
      return { orders, pages: Number(raw) };
    } finally { release(); }
  }
  async function fetchPrice(id: number, signal: AbortSignal): Promise<Price> {
    const first = await page(id, 1, signal);
    let sell = cents(summarizeBuybackOrders(first.orders, id).sell);
    for (let number = 2; number <= first.pages; number++) {
      if (signal.aborted) throw cancelled();
      const next = await page(id, number, signal);
      if (next.pages !== first.pages) throw new Error("Fitting market pagination changed");
      const value = cents(summarizeBuybackOrders(next.orders, id).sell);
      if (value !== null && (sell === null || value < sell)) sell = value;
    }
    if (signal.aborted) throw cancelled();
    return { cents: sell, checkedAt: clock() };
  }
  async function quoteFits(fits: CanonicalFit[], options: Options = {}): Promise<FittingAdvicePrice[]> {
    if (!Array.isArray(fits) || fits.length > FITTING_ADVICE_PRICE_LIMITS.fits) throw new Error("一次最多估算原配置和两份建议配置。");
    const startedAt = clock(), controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const timer = setTimeout(abort, deadlineMs), signal = controller.signal;
    try {
      const bills = fits.map(collect);
      const ids = [...new Set(bills.flatMap(bill => [...bill.quantities.keys(), ...bill.invalidTypeIds]))].sort((a,b) => a-b);
      const tooMany = ids.length > FITTING_ADVICE_PRICE_LIMITS.types;
      const snapshot = new Map<number, Price>();
      if (!tooMany && !signal.aborted) {
        for (const [id, saved] of cache) if (saved.expiresAt <= startedAt) cache.delete(id);
        const missing: number[] = [];
        for (const id of ids) {
          const saved = cache.get(id);
          if (saved && saved.expiresAt > startedAt) { snapshot.set(id, { cents: saved.cents, checkedAt: saved.checkedAt }); cache.delete(id); cache.set(id, saved); }
          else missing.push(id);
        }
        let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(FITTING_ADVICE_PRICE_LIMITS.concurrency, missing.length) }, async () => {
          while (!signal.aborted && cursor < missing.length) {
            const id = missing[cursor++]!;
            try { const value = await fetchPrice(id, signal); if (!signal.aborted) { snapshot.set(id,value); remember(id,value); } }
            catch (error) {
              // Stop this entire batch on ESI throttling rather than probing
              // every remaining type while the same provider is unavailable.
              if (error instanceof MarketRateLimited) controller.abort();
              // No partial/stale price and no upstream payload in output.
            }
          }
        }));
      }
      const checkedAt = new Date(Math.min(startedAt, ...[...snapshot.values()].map(value => value.checkedAt))).toISOString();
      return bills.map((bill): FittingAdvicePrice => {
        const missing = new Set(bill.invalidTypeIds);
        let total = 0n;
        for (const [id, quantity] of bill.quantities) {
          const value = snapshot.get(id)?.cents;
          if (tooMany || value === undefined || value === null || missing.has(id)) { missing.add(id); continue; }
          const item = value * quantity;
          if (item > MAX_SAFE || total + item > MAX_SAFE) { missing.add(id); continue; }
          total += item;
        }
        const complete = !tooMany && !bill.invalid && missing.size === 0;
        const note = BASE_NOTE + (tooMany ? "本批次超过 80 种物品，未查询行情，无法确认预算。" : !complete ? "存在缺价或数量/金额异常，无法确认总价或预算达标。" : "");
        return { estimatedTotalIsk: complete ? Number(total) / 100 : null, complete, basis: "jita_sell", checkedAt, missingTypeIds: [...missing].sort((a,b) => a-b), note };
      });
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); controller.abort(); }
  }
  return { quoteFits };
}

const service = createFittingAdvicePriceService();
export const quoteFits = service.quoteFits;
