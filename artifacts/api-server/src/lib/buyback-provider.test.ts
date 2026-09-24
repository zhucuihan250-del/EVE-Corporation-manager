import assert from "node:assert/strict";
import test from "node:test";
import {
  getBuybackTarget,
  normalizeBuybackName,
  resolveBuybackTypes,
  searchBuybackCatalog,
} from "./buyback-catalog";
import {
  getBuybackMarketPrices,
  summarizeBuybackOrders,
  type BuybackMarketOrder,
} from "./buyback-market";

test("bilingual official catalog resolves exact names, including non-fitting materials", async () => {
  const values = await resolveBuybackTypes([
    "三钛合金",
    "Tritanium",
    "  tritanium  ",
    "Tritani",
    "Light Missile Launcher II",
  ]);
  assert.equal(values.get("三钛合金")?.typeId, 34);
  assert.equal(values.get("Tritanium")?.categoryId, 4);
  assert.equal(values.get("  tritanium  ")?.typeId, 34);
  assert.equal(values.get("Light Missile Launcher II")?.typeId, 2404);
  assert.equal(values.has("Tritani"), false);
  assert.equal(normalizeBuybackName(" Ｔｒｉｔａｎｉｕｍ "), "tritanium");
});
test("catalog search is bounded, category-aware and validates target IDs", async () => {
  assert.equal((await getBuybackTarget("type", 34))?.categoryId, 4);
  assert.equal((await getBuybackTarget("category", 4))?.id, 4);
  assert.equal(await getBuybackTarget("type", -1), null);
  assert.equal((await searchBuybackCatalog("Tritanium", "type"))[0]?.id, 34);
  assert.ok((await searchBuybackCatalog("", "type")).length <= 50);
  assert.ok((await searchBuybackCatalog("", "category")).length > 20);
});
const order = (
  type: number,
  buy: boolean,
  price: number,
  overrides: Partial<BuybackMarketOrder> = {},
): BuybackMarketOrder => ({
  location_id: 60003760,
  type_id: type,
  is_buy_order: buy,
  price,
  volume_remain: 100,
  ...overrides,
});
test("market snapshot uses exact Jita station and ignores malformed or exhausted orders", () => {
  const values = summarizeBuybackOrders(
    [
      order(34, true, 4.12),
      order(34, true, 4.2),
      order(34, false, 4.5),
      order(34, false, 4.6),
      order(34, true, 99, { location_id: 60008494 }),
      order(35, true, 99),
      order(34, false, 0.01, { volume_remain: 0 }),
      order(34, true, 999, { volume_remain: NaN }),
      order(34, true, Infinity),
      order(34, false, -10),
    ],
    34,
  );
  assert.deepEqual(values, { buy: "4.20", sell: "4.50" });
  assert.deepEqual(summarizeBuybackOrders([order(34, false, 4.5)], 34), {
    buy: null,
    sell: "4.50",
  });
});
test("provider fetches every page and deduplicates concurrent and cached requests", async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url) => {
    requests++;
    const page = new URL(String(url)).searchParams.get("page");
    return new Response(
      JSON.stringify([order(1000001, page === "1", page === "1" ? 20 : 30)]),
      {
        headers: {
          "X-Pages": "2",
          "Last-Modified": "Wed, 23 Sep 2026 01:00:00 GMT",
        },
      },
    );
  };
  try {
    const [left, right] = await Promise.all([
      getBuybackMarketPrices([1000001]),
      getBuybackMarketPrices([1000001]),
    ]);
    assert.deepEqual(left.get(1000001), {
      buy: "20.00",
      sell: "30.00",
      updatedAt: "2026-09-23T01:00:00.000Z",
    });
    assert.deepEqual(left, right);
    await getBuybackMarketPrices([1000001]);
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = original;
  }
});
test("provider never quotes partial pagination or exposes upstream error bodies", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const id = new URL(String(url)).searchParams.get("type_id");
    const page = new URL(String(url)).searchParams.get("page");
    if (id === "1000002" && page === "1")
      return new Response(JSON.stringify([order(1000002, true, 20)]), {
        headers: { "X-Pages": "2" },
      });
    return new Response("PRIVATE UPSTREAM BODY", { status: 503 });
  };
  try {
    const values = await getBuybackMarketPrices([1000002, 1000003]);
    for (const value of values.values()) {
      assert.equal(value.buy, null);
      assert.equal(value.sell, null);
      assert.ok(value.error);
      assert.ok(!value.error.includes("PRIVATE"));
    }
  } finally {
    globalThis.fetch = original;
  }
});
test("provider concurrency remains bounded across callers and enforces work limits", async () => {
  const original = globalThis.fetch;
  let current = 0,
    maximum = 0;
  globalThis.fetch = async (url) => {
    current++;
    maximum = Math.max(maximum, current);
    await new Promise((resolve) => setTimeout(resolve, 5));
    current--;
    const type = Number(new URL(String(url)).searchParams.get("type_id"));
    return new Response(JSON.stringify([order(type, true, 2)]));
  };
  try {
    await Promise.all([
      getBuybackMarketPrices([1000010, 1000011, 1000012, 1000013, 1000014]),
      getBuybackMarketPrices([1000020, 1000021, 1000022, 1000023]),
    ]);
    assert.ok(maximum <= 4);
    await assert.rejects(
      getBuybackMarketPrices(Array.from({ length: 81 }, (_, i) => i + 1)),
    );
    await assert.rejects(getBuybackMarketPrices([0]));
  } finally {
    globalThis.fetch = original;
  }
});
test("rate limiting suppresses immediate retry instead of assuming missing prices are zero", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("Too many requests", {
      status: 429,
      headers: { "Retry-After": "60" },
    });
  };
  try {
    assert.ok((await getBuybackMarketPrices([1000100])).get(1000100)?.error);
    assert.ok((await getBuybackMarketPrices([1000101])).get(1000101)?.error);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
