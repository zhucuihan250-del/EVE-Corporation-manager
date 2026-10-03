import assert from "node:assert/strict";
import test from "node:test";
import { calculatePapConversion, commonPapUnits, formatPapUnits, MAX_PAP_RATE, parsePapDecimal } from "./pap-currency-math";

test("decimal parsing is exact and rejects exponents, truncation, negatives and invalid values", () => {
  assert.equal(formatPapUnits(parsePapDecimal("1.25")), "1.250000");
  assert.equal(formatPapUnits(parsePapDecimal("0.5")), "0.500000");
  for (const value of [0.5, "1e3", "1.0000001", "NaN", "-1", "Infinity", "1,000", " 1", "1000000000.000001"]) assert.throws(() => parsePapDecimal(value));
  assert.equal(parsePapDecimal("-1.25", 6, true), -1_250_000n);
  assert.throws(() => parsePapDecimal("1000000.000001", 6, false, MAX_PAP_RATE));
  assert.equal(commonPapUnits(0.1 + 0.2), 300000n);
});
test("one-way conversion supports 0.5 and 1.25 exact factors", () => {
  assert.equal(formatPapUnits(calculatePapConversion(parsePapDecimal("1.25"), parsePapDecimal("0.5"), 0n).commonAmount), "0.625000");
  assert.equal(formatPapUnits(calculatePapConversion(parsePapDecimal("0.5"), parsePapDecimal("1.25"), 0n).commonAmount), "0.625000");
  assert.throws(() => calculatePapConversion(1n, 1n, 0n));
});
test("partition invariance retains all submicro carry and cannot mint by splitting", () => {
  for (const rate of ["0.333333", "0.500001", "1.234567", "999.999999"]) {
    let credit = 0n, carry = 0n, total = 0n;
    for (let i = 1n; i <= 100n; i++) {
      const amount = i * 10n; total += amount;
      const result = calculatePapConversion(amount, parsePapDecimal(rate), carry);
      credit += result.commonAmount; carry = result.carryAfter;
    }
    const one = calculatePapConversion(total, parsePapDecimal(rate), 0n);
    assert.equal(credit, one.commonAmount); assert.equal(carry, one.carryAfter);
  }
});
