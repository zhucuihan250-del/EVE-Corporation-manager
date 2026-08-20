import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePapMarketIskValue,
  nextPapMarketOrderStatus,
  normalizeMarketPap,
  settlePapTransfer,
} from "./pap-market-rules";

test("PAP Market value is calculated only from PAP amount", () => {
  assert.equal(calculatePapMarketIskValue(1), 100_000_000);
  assert.equal(calculatePapMarketIskValue(50), 5_000_000_000);
  assert.equal(calculatePapMarketIskValue(0.5), 50_000_000);
  assert.throws(() => normalizeMarketPap(0));
  assert.throws(() => normalizeMarketPap(1_000_001));
});

test("partial fills produce deterministic order states", () => {
  assert.equal(nextPapMarketOrderStatus(100, 0), "open");
  assert.equal(nextPapMarketOrderStatus(70, 30), "partially_filled");
  assert.equal(nextPapMarketOrderStatus(0, 100), "filled");
});

test("approval conserves total PAP and consumes seller lock", () => {
  const beforeTotal = 100 + 25;
  const settled = settlePapTransfer({ sellerBalance: 100, sellerLocked: 40, buyerBalance: 25, amount: 30 });
  assert.deepEqual(settled, { sellerBalance: 70, sellerLocked: 10, buyerBalance: 55 });
  assert.equal(settled.sellerBalance + settled.buyerBalance, beforeTotal);
  assert.throws(() => settlePapTransfer({ sellerBalance: 100, sellerLocked: 5, buyerBalance: 25, amount: 30 }));
});
