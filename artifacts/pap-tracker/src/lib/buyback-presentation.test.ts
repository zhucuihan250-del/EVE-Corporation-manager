import assert from "node:assert/strict";
import test from "node:test";
import {
  canCopyBuybackQuote,
  formatBuybackIsk,
} from "./buyback-presentation.ts";

test("ISK formatting preserves cents beyond the safe floating-point range", () => {
  assert.equal(
    formatBuybackIsk("999999999999999999.99"),
    "999,999,999,999,999,999.99 ISK",
  );
  assert.equal(formatBuybackIsk("0.0000001234"), "0.0000001234 ISK");
  assert.equal(formatBuybackIsk("1000.00"), "1,000.00 ISK");
  assert.equal(formatBuybackIsk("0.00"), "0.00 ISK");
  assert.equal(formatBuybackIsk(null), "—");
});

const quote = {
  complete: true,
  totalIsk: "999999999999999999.99",
  expiresAt: "2026-09-24T12:00:00Z",
};
const expiry = Date.parse(quote.expiresAt);

test("only complete, non-expired positive quotes are copyable", () => {
  assert.equal(canCopyBuybackQuote(quote, expiry - 1), true);
  assert.equal(
    canCopyBuybackQuote({ ...quote, complete: false }, expiry - 1),
    false,
  );
  assert.equal(canCopyBuybackQuote(quote, expiry), false);
  assert.equal(canCopyBuybackQuote(quote, expiry + 1), false);
  assert.equal(
    canCopyBuybackQuote({ ...quote, totalIsk: "0.00" }, expiry - 1),
    false,
  );
});

test("malformed dates or amounts can never be copied as a contract quote", () => {
  for (const totalIsk of ["-1.00", "1,000.00", "1e10", "", "NaN", "0.001"]) {
    assert.equal(
      canCopyBuybackQuote({ ...quote, totalIsk }, expiry - 1),
      false,
    );
  }
  assert.equal(
    canCopyBuybackQuote({ ...quote, expiresAt: "not-a-date" }, expiry - 1),
    false,
  );
  assert.equal(canCopyBuybackQuote(quote, Number.NaN), false);
});
