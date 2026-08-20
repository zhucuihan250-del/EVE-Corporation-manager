import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIVITY_MONTHLY_PAP_DEDUCTION,
  calculateActivityPapDeduction,
} from "./activity-rules";

test("activity settlement always charges the fixed two PAP requirement", () => {
  assert.equal(ACTIVITY_MONTHLY_PAP_DEDUCTION, 2);
  assert.deepEqual(calculateActivityPapDeduction(8), {
    deductedPap: 2,
    shortfallPap: 0,
    hasInsufficientPap: false,
  });
});

test("activity settlement records partial deduction and an exact shortage alert", () => {
  assert.deepEqual(calculateActivityPapDeduction(1.25), {
    deductedPap: 1.25,
    shortfallPap: 0.75,
    hasInsufficientPap: true,
  });
  assert.deepEqual(calculateActivityPapDeduction(0), {
    deductedPap: 0,
    shortfallPap: 2,
    hasInsufficientPap: true,
  });
});
