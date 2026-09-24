import assert from "node:assert/strict";
import test from "node:test";
import {
  BuybackError, DEFAULT_BUYBACK_SETTINGS, calculateBuybackQuote, decimalUnits,
  effectiveBuybackRule, formatUnits, parseBuybackClipboard, validateBuybackRule, validateBuybackSettings,
  type BuybackRule, type BuybackSettings, type BuybackType,
} from "./buyback-calculation";
import { BuybackRequestLimiter } from "./buyback-service";

const tritanium: BuybackType = { typeId: 34, name: "Tritanium", categoryId: 4, categoryName: "Material" };
const settings: BuybackSettings = { ...DEFAULT_BUYBACK_SETTINGS, enabled: true };
const rule = (input: Partial<BuybackRule>): BuybackRule => ({ scope: "type", targetId: 34, enabled: null, priceBasis: null, fixedPrice: null, ratePercent: null, ...input });
const calculate = (text: string, overrides: Partial<BuybackSettings> = {}, rules: BuybackRule[] = []) => calculateBuybackQuote(
  parseBuybackClipboard(text), { ...settings, ...overrides }, rules,
  new Map([["Tritanium", tritanium]]), new Map([[34, { buy: "1.01", sell: "1.02", updatedAt: "2026-09-24T00:00:00.000Z" }]]),
);

test("clipboard keeps names with trailing numbers intact and only parses explicit quantities", () => {
  assert.deepEqual(parseBuybackClipboard("Cap Booster 800\nNanite Repair Paste\nTritanium × 1,200"), [
    { inputName: "Cap Booster 800", quantity: 1, error: null },
    { inputName: "Nanite Repair Paste", quantity: 1, error: null },
    { inputName: "Tritanium", quantity: 1200, error: null },
  ]);
  assert.deepEqual(parseBuybackClipboard("Tritanium\t1,200\tMineral\t1,200 m3")[0], { inputName: "Tritanium", quantity: 1200, error: null });
});

test("malformed quantities are flagged rather than coerced or rounded", () => {
  for (const quantity of ["1.5", "1,5", "-1", "0", "", "1e3", "1 20", "9007199254740992"]) {
    assert.ok(parseBuybackClipboard(`Tritanium\t${quantity}`)[0]!.error, quantity);
  }
  assert.equal(parseBuybackClipboard("Tritanium\t1 200")[0]!.quantity, 1200);
});

test("ordinary abyssal and mutaplasmid names are not blanket-rejected", () => {
  const rows = parseBuybackClipboard("深渊纤维\t5\n不稳定突变质体\t2\nAbyssal Filament\t4");
  assert.ok(rows.every(row => row.error === null));
  assert.ok(parseBuybackClipboard("Raven Blueprint\t1\tBlueprint Copy")[0]!.error);
});

test("blueprint originals and copies cannot silently share a market or fixed quote", () => {
  const type = { ...tritanium, categoryId: 9 };
  for (const basis of ["buy", "fixed"] as const) {
    const result = calculateBuybackQuote(parseBuybackClipboard("Tritanium"), { ...settings, priceBasis: basis, fixedPrice: "1000" }, [], new Map([["Tritanium", type]]), new Map([[34, { buy: "10000000", sell: null, updatedAt: "now" }]]));
    assert.equal(result.complete, false);
    assert.equal(result.lines[0]!.status, "invalid");
    assert.equal(result.totalIsk, "0.00");
    assert.match(result.lines[0]!.reason!, /原图和副本/);
  }
});

test("each property inherits item then category then global, including false overrides", () => {
  const rules = [rule({ scope: "category", targetId: 4, enabled: false, priceBasis: "sell", ratePercent: 90 }), rule({ enabled: true, ratePercent: 95 })];
  assert.deepEqual(effectiveBuybackRule(settings, rules, tritanium), { enabled: true, priceBasis: "sell", ratePercent: 95, fixedPrice: null });
  assert.equal(calculate("Tritanium", {}, [rule({ enabled: false })]).lines[0]!.status, "excluded");
  assert.equal(calculate("Tritanium", { defaultEnabled: false }, [rule({ enabled: true })]).complete, true);
});

test("prices use fixed-point arithmetic and round each line to cents", () => {
  const result = calculate("Tritanium\t3", { priceBasis: "mid", ratePercent: 99.99 });
  assert.equal(result.lines[0]!.referencePrice, "1.015");
  assert.equal(result.lines[0]!.unitPrice, "1.0148985");
  assert.equal(result.totalIsk, "3.04");
  assert.equal(result.lines[0]!.marketUpdatedAt, "2026-09-24T00:00:00.000Z");
  const large = calculate("Tritanium", { priceBasis: "fixed", fixedPrice: "999999999999999.99", ratePercent: 100 });
  assert.equal(large.totalIsk, "999999999999999.99");
  assert.equal(large.lines[0]!.marketUpdatedAt, null);
});

test("sum of rounded lines exactly equals displayed total", () => {
  const result = calculate("Tritanium\t1\nTritanium\t1\nTritanium\t1", { priceBasis: "fixed", fixedPrice: "0.01", ratePercent: 150 });
  assert.deepEqual(result.lines.map(line => line.totalIsk), ["0.02", "0.02", "0.02"]);
  assert.equal(result.totalIsk, "0.06");
  assert.equal(formatUnits(decimalUnits("100.00", 6)!, 6, true), "100");
  assert.equal(decimalUnits("1e3", 6), null);
});

test("missing prices and unknown names are separate from excluded items and never valued at zero", () => {
  const result = calculateBuybackQuote(parseBuybackClipboard("Tritanium\nUnknown"), settings, [], new Map([["Tritanium", tritanium]]), new Map());
  assert.deepEqual(result.lines.map(line => line.status), ["unpriced", "unrecognized"]);
  assert.ok(result.lines.every(line => line.totalIsk === null));
  assert.equal(result.complete, false);
  const midpoint = calculateBuybackQuote(parseBuybackClipboard("Tritanium"), { ...settings, priceBasis: "mid" }, [], new Map([["Tritanium", tritanium]]), new Map([[34, { buy: "10", sell: null, updatedAt: "now" }]]));
  assert.equal(midpoint.lines[0]!.status, "unpriced");
});

test("settings and rule validators reject unsafe values and permit explicit inheritance", () => {
  for (const ratePercent of [0, -1, Infinity, 1000.01, 99.999]) assert.throws(() => validateBuybackSettings({ ...settings, ratePercent }), BuybackError);
  assert.throws(() => validateBuybackSettings({ ...settings, priceBasis: "fixed", fixedPrice: null }), BuybackError);
  assert.throws(() => validateBuybackSettings({ ...settings, fixedPrice: "1000000000000000.01" }), BuybackError);
  assert.throws(() => validateBuybackSettings({ ...settings, quoteValidityMinutes: 1441 }), BuybackError);
  assert.equal(validateBuybackRule(rule({ priceBasis: "fixed", fixedPrice: null })).fixedPrice, null);
});

test("input length, row count, amount bounds and rate limiter cap resources", () => {
  assert.throws(() => parseBuybackClipboard("x".repeat(100001)), BuybackError);
  assert.throws(() => parseBuybackClipboard(Array(201).fill("Tritanium").join("\n")), BuybackError);
  assert.throws(() => calculate("Tritanium\t1000000", { priceBasis: "fixed", fixedPrice: "1000000000000000" }), BuybackError);
  let now = 100;
  const limiter = new BuybackRequestLimiter(() => now);
  limiter.take("user", 2); limiter.take("user", 2);
  assert.throws(() => limiter.take("user", 2), { code: "BUYBACK_RATE_LIMIT" });
  now += 60_000;
  assert.doesNotThrow(() => limiter.take("user", 2));
});
