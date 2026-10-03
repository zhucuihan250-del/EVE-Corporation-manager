import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPapDecimal,
  hasPapValue,
  isPositivePapInput,
  papEntryTypeLabel,
} from "./pap-currency-presentation.ts";

test("PAP display preserves six decimals and large values without floating point", () => {
  assert.equal(
    formatPapDecimal("9999999999999999.123456"),
    "9,999,999,999,999,999.123456",
  );
  assert.equal(formatPapDecimal("12345.500000"), "12,345.5");
  assert.equal(formatPapDecimal("-0.000001"), "-0.000001");
  assert.equal(formatPapDecimal("-0.000000"), "0");
  assert.equal(formatPapDecimal("0001.200000"), "1.2");
});

test("conversion carry remains visible below a micro PAP", () => {
  assert.equal(formatPapDecimal("0.000000000001"), "0.000000000001");
  assert.equal(formatPapDecimal("0.000000500000"), "0.0000005");
  assert.equal(hasPapValue("0.000000000001"), true);
  assert.equal(hasPapValue("0.000000000000"), false);
});

test("PAP inputs accept positive six-place decimals only", () => {
  for (const input of ["1", "0.000001", "5.125000", "0002.5"])
    assert.equal(isPositivePapInput(input), true, input);
  for (const input of [
    "0",
    "0.000000",
    "-1",
    "0.0000001",
    "1e6",
    "1,000",
    ".5",
    "1.",
    "NaN",
    "",
    " 1 ",
  ])
    assert.equal(isPositivePapInput(input), false, input);
});

test("amount and exchange-rate limits are checked without Number rounding", () => {
  assert.equal(isPositivePapInput("1000000000.000000"), true);
  assert.equal(isPositivePapInput("1000000000.000001"), false);
  assert.equal(isPositivePapInput("1000000.000000", 1_000_000n), true);
  assert.equal(isPositivePapInput("1000000.000001", 1_000_000n), false);
  assert.equal(isPositivePapInput("0".repeat(41) + "1"), false);
});

test("invalid display values and entry labels remain explicit", () => {
  for (const value of [null, undefined, "NaN", "<script>", "1e10"])
    assert.equal(formatPapDecimal(value), "—");
  assert.equal(papEntryTypeLabel("conversion", true), "兑换为通用 PAP");
  assert.equal(papEntryTypeLabel("adjustment", false), "Admin adjustment");
});
