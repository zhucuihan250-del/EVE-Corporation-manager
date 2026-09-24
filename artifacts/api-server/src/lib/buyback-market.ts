const REGION_ID = 10000002;
const STATION_ID = 60003760;
const CACHE_MS = 5 * 60_000;
const MAX_TYPES = 80;
const MAX_PAGES = 30;
const MAX_CONCURRENT_REQUESTS = 4;

export type BuybackMarketPrice = {
  buy: string | null;
  sell: string | null;
  updatedAt: string;
  error?: string;
};
export type BuybackMarketOrder = {
  location_id: number;
  type_id: number;
  is_buy_order: boolean;
  price: number;
  volume_remain: number;
};
export function summarizeBuybackOrders(
  orders: BuybackMarketOrder[],
  typeId: number,
): Pick<BuybackMarketPrice, "buy" | "sell"> {
  let buy: number | null = null;
  let sell: number | null = null;
  for (const order of orders) {
    if (
      order.location_id !== STATION_ID ||
      order.type_id !== typeId ||
      !Number.isFinite(order.volume_remain) ||
      order.volume_remain <= 0 ||
      !Number.isFinite(order.price) ||
      order.price <= 0 ||
      order.price > 1e13
    )
      continue;
    if (order.is_buy_order === true)
      buy = buy === null ? order.price : Math.max(buy, order.price);
    else if (order.is_buy_order === false)
      sell = sell === null ? order.price : Math.min(sell, order.price);
  }
  return { buy: buy?.toFixed(2) ?? null, sell: sell?.toFixed(2) ?? null };
}

const cache = new Map<
  number,
  { expiresAt: number; value: BuybackMarketPrice }
>();
const pending = new Map<number, Promise<BuybackMarketPrice>>();
let active = 0;
const queue: Array<() => void> = [];
let blockedUntil = 0;
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT_REQUESTS)
    await new Promise<void>((resolve) => queue.push(resolve));
  else active++;
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}
async function page(
  typeId: number,
  number: number,
): Promise<{ orders: BuybackMarketOrder[]; pages: number; updatedAt: string }> {
  return limited(async () => {
    if (Date.now() < blockedUntil) throw new Error("市场接口限流，请稍后重算");
    let response: Response;
    try {
      response = await fetch(
        `https://esi.evetech.net/latest/markets/${REGION_ID}/orders/?datasource=tranquility&order_type=all&type_id=${typeId}&page=${number}`,
        {
          headers: {
            Accept: "application/json",
            "User-Agent":
              process.env.EVE_ESI_USER_AGENT ||
              "EVE-Corporation-Manager/1.0 buyback-calculator",
          },
          signal: AbortSignal.timeout(12_000),
        },
      );
    } catch {
      blockedUntil = Math.max(blockedUntil, Date.now() + 15_000);
      throw new Error("市场服务连接失败，请稍后重算");
    }
    if (response.status === 429 || response.status === 420) {
      const retry = Number(response.headers.get("retry-after") || 60);
      blockedUntil =
        Date.now() +
        Math.min(900, Math.max(30, Number.isFinite(retry) ? retry : 60)) * 1000;
    }
    if (!response.ok) throw new Error("市场行情暂不可用，请稍后重算");
    const orders: unknown = await response.json();
    const pages = Number(response.headers.get("x-pages") || 1);
    if (
      !Array.isArray(orders) ||
      !Number.isInteger(pages) ||
      pages < 1 ||
      pages > MAX_PAGES
    )
      throw new Error("市场数据不完整，未采用部分行情报价");
    const lastModified = response.headers.get("last-modified");
    const timestamp = lastModified ? Date.parse(lastModified) : NaN;
    return {
      orders: orders as BuybackMarketOrder[],
      pages,
      updatedAt: new Date(
        Number.isFinite(timestamp) ? timestamp : Date.now(),
      ).toISOString(),
    };
  });
}
async function getPrice(typeId: number): Promise<BuybackMarketPrice> {
  const saved = cache.get(typeId);
  if (saved && saved.expiresAt > Date.now()) return saved.value;
  const inFlight = pending.get(typeId);
  if (inFlight) return inFlight;
  const request = (async () => {
    try {
      const first = await page(typeId, 1);
      const orders = [...first.orders];
      for (let number = 2; number <= first.pages; number++) {
        const next = await page(typeId, number);
        if (next.pages !== first.pages)
          throw new Error("市场分页发生变化，请重新报价");
        orders.push(...next.orders);
      }
      const value = {
        ...summarizeBuybackOrders(orders, typeId),
        updatedAt: first.updatedAt,
      };
      if (cache.size > 5000) cache.clear();
      cache.set(typeId, { expiresAt: Date.now() + CACHE_MS, value });
      return value;
    } catch (error) {
      // Do not expose upstream response bodies or treat a service failure as 0 ISK.
      const value = {
        buy: null,
        sell: null,
        updatedAt: new Date().toISOString(),
        error:
          error instanceof Error && /市场/.test(error.message)
            ? error.message
            : "市场行情暂不可用，请稍后重算",
      };
      cache.set(typeId, { expiresAt: Date.now() + 15_000, value });
      return value;
    } finally {
      pending.delete(typeId);
    }
  })();
  pending.set(typeId, request);
  return request;
}
export async function getBuybackMarketPrices(
  typeIds: number[],
): Promise<Map<number, BuybackMarketPrice>> {
  const ids = [...new Set(typeIds)];
  if (
    ids.length > MAX_TYPES ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  )
    throw new Error("一次报价最多支持 80 种有效物品");
  const result = new Map<number, BuybackMarketPrice>();
  // Batch dispatch bounds both active requests and pending work per quotation.
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(MAX_CONCURRENT_REQUESTS, ids.length) },
      async () => {
        while (cursor < ids.length) {
          const id = ids[cursor++]!;
          result.set(id, await getPrice(id));
        }
      },
    ),
  );
  return result;
}
