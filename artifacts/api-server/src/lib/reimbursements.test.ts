import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateReferenceReimbursementAmount,
  collectFixedNpcCargoDeductions,
} from "./reimbursements";

test("fixed NPC cargo deductions include destroyed and dropped cargo quantities", () => {
  const deductions = collectFixedNpcCargoDeductions([
    {
      item_type_id: 55932,
      flag: 5,
      quantity_destroyed: 2,
      quantity_dropped: 1,
    },
  ]);

  assert.deepEqual(deductions, [{
    typeId: 55932,
    quantity: 3,
    unitPrice: 10_000_000,
    totalValue: 30_000_000,
  }]);
});

test("fixed-price fitted items and ordinary market cargo are not deducted", () => {
  assert.deepEqual(collectFixedNpcCargoDeductions([
    { item_type_id: 55932, flag: 27, quantity_destroyed: 1 },
    { item_type_id: 34, flag: 5, quantity_dropped: 50_000 },
  ]), []);
});

test("nested cargo and fleet hangar cargo are combined by item type", () => {
  const deductions = collectFixedNpcCargoDeductions([
    {
      item_type_id: 17365,
      flag: 5,
      quantity_dropped: 1,
      items: [{ item_type_id: 19421, quantity_dropped: 1 }],
    },
    { item_type_id: 19421, flag: 155, quantity_destroyed: 2 },
  ]);

  assert.deepEqual(deductions, [{
    typeId: 19421,
    quantity: 3,
    unitPrice: 133_837_000,
    totalValue: 401_511_000,
  }]);
});

test("reference reimbursement subtracts insurance and fixed NPC cargo without going negative", () => {
  assert.equal(calculateReferenceReimbursementAmount(500_000_000, 100_000_000, 30_000_000), 370_000_000);
  assert.equal(calculateReferenceReimbursementAmount(100_000_000, 80_000_000, 30_000_000), 0);
});
