import assert from "node:assert/strict";
import test, { after } from "node:test";
import type { Calculation } from "@eveshipfit/dogma-engine";
import { closeFittingEngine, simulateWorkbench } from "./fitting-engine";
import { getFittingData, getFittingType, type FittingType } from "./fitting-data";
import { applySubsystemLayoutCompatibility } from "./fitting-subsystem-compatibility";
import type { CanonicalFit } from "./fitting-engine-types";

after(closeFittingEngine);
const data = getFittingData();
function type(name: string): FittingType {
  const item = data.types.find(item => item.name.en === name);
  assert.ok(item, name);
  return item;
}
function fit(ship = "Tengu", slots: CanonicalFit["slots"] = []): CanonicalFit {
  return { schemaVersion: 2, shipTypeId: type(ship).id, name: "T3 layout regression", slots, drones: [], cargo: [], skillProfile: { mode: "all5" }, damageProfile: { em: 0.25, thermal: 0.25, kinetic: 0.25, explosive: 0.25 } };
}
const subsystem = (typeId = 45601, index = 0, state: CanonicalFit["slots"][number]["state"] = "online"): CanonicalFit["slots"][number] => ({ rack: "subsystem", index, typeId, state });
const launcher = (index = 0): CanonicalFit["slots"][number] => ({ rack: "high", index, typeId: 501, state: "active", chargeTypeId: 209 });
const closeTo = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} ~= ${expected}`);

for (const shipName of ["Tengu", "Loki", "Proteus", "Legion"]) {
  test(`${shipName}: every current subsystem family restores its exact SDE rack and hardpoint increments`, async () => {
    const hull = type(shipName);
    const choices = data.types.filter(item => item.published && item.categoryId === 32 && item.attributes.fitsToShipType === hull.id);
    assert.equal(choices.length, 12);
    for (const choice of choices) {
      const result = await simulateWorkbench(fit(shipName, [subsystem(choice.id)]), "en");
      assert.equal(result.slots.high.limit, (hull.attributes.hiSlots ?? 0) + (choice.attributes.hiSlotModifier ?? 0), choice.name.en);
      assert.equal(result.slots.medium.limit, (hull.attributes.medSlots ?? 0) + (choice.attributes.medSlotModifier ?? 0), choice.name.en);
      assert.equal(result.slots.low.limit, (hull.attributes.lowSlots ?? 0) + (choice.attributes.lowSlotModifier ?? 0), choice.name.en);
      assert.equal(result.hardpoints.turret.limit, (hull.attributes.turretSlotsLeft ?? 0) + (choice.attributes.turretHardPointModifier ?? 0), choice.name.en);
      assert.equal(result.hardpoints.launcher.limit, (hull.attributes.launcherSlotsLeft ?? 0) + (choice.attributes.launcherHardPointModifier ?? 0), choice.name.en);
      assert.equal(result.moduleStates[0]!.state, "online", choice.name.en);
      assert.equal(result.moduleStates[0]!.maxState, "online", choice.name.en);
      assert.ok(result.engine.compatibilityCorrections?.length, choice.name.en);
      assert.match(result.engine.note, /compatibility correction/u);
    }
  });
}

test("full T3 layout sums one legal subsystem per family, matching catalog eligibility", async () => {
  const selected = [45626, 45589, 45601, 45614];
  const result = await simulateWorkbench(fit("Tengu", selected.map((id, index) => subsystem(id, index))), "en");
  assert.equal(result.slots.high.limit, 8);
  assert.equal(result.slots.medium.limit, 6);
  assert.equal(result.slots.low.limit, 3);
  assert.equal(result.hardpoints.launcher.limit, 6);
  assert.equal(result.hardpoints.turret.limit, 0);
  assert.equal(result.valid, true);
  assert.ok(result.engine.compatibilityCorrections!.every(correction => correction.sdeBuildNumber === 3561556));
});

test("Tengu six-launcher golden fit becomes valid without changing its Dogma CPU/PG result", async () => {
  const result = await simulateWorkbench(fit("Tengu", [subsystem(), ...Array.from({ length: 6 }, (_, index) => launcher(index))]), "en");
  assert.equal(result.slots.high.limit, 7);
  assert.equal(result.slots.high.used, 6);
  assert.equal(result.hardpoints.launcher.limit, 6);
  assert.equal(result.hardpoints.launcher.used, 6);
  closeTo(result.resources.cpu.used, 168.75);
  closeTo(result.resources.cpu.limit, 587.5);
  closeTo(result.resources.powergrid.used, 405);
  closeTo(result.resources.powergrid.limit, 762.5);
  assert.equal(result.valid, true, JSON.stringify(result.violations));
  assert.deepEqual(result.violations, []);
});

test("Tengu seventh launcher still fails the recomputed launcher hardpoint limit", async () => {
  const result = await simulateWorkbench(fit("Tengu", [subsystem(), ...Array.from({ length: 7 }, (_, index) => launcher(index))]), "en");
  assert.equal(result.slots.high.overloaded, false);
  assert.equal(result.hardpoints.launcher.overloaded, true);
  closeTo(result.resources.cpu.used, 196.875);
  closeTo(result.resources.powergrid.used, 472.5);
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(violation => violation.rule.type === "slots" && violation.rule.slot === "launcher" && violation.rule.available === 6 && violation.rule.used === 7));
});

test("high-rack quantity overload and sparse out-of-range indices remain invalid", async () => {
  const utility = type("Small Energy Neutralizer I").id;
  const quantity = await simulateWorkbench(fit("Tengu", [subsystem(), ...Array.from({ length: 8 }, (_, index) => ({ rack: "high" as const, index, typeId: utility, state: "online" as const }))]), "en");
  assert.equal(quantity.valid, false);
  assert.ok(quantity.violations.some(violation => violation.rule.type === "slots" && violation.rule.slot === "high" && violation.rule.available === 7 && violation.rule.used === 8));
  const sparse = await simulateWorkbench(fit("Tengu", [subsystem(), launcher(7)]), "zh");
  assert.equal(sparse.slots.high.used, 1);
  assert.equal(sparse.valid, false);
  const indexViolation = sparse.violations.find(violation => violation.rule.type === "slot_index");
  assert.ok(indexViolation);
  assert.equal(indexViolation.rule.index, 7);
  assert.equal(indexViolation.rule.available, 7);
  assert.match(indexViolation.message, /第 8 个槽位不存在/u);
});

test("a subsystem outside its rack address space cannot grant layout or normalize its state", async () => {
  const result = await simulateWorkbench(fit("Tengu", [subsystem(45601, 31)]), "en");
  assert.equal(result.valid, false);
  assert.equal(result.slots.high.limit, 0);
  assert.equal(result.hardpoints.launcher.limit, 0);
  assert.equal(result.moduleStates[0]!.state, "offline");
  assert.equal(result.engine.compatibilityCorrections, undefined);
  assert.ok(result.violations.some(violation => violation.rule.type === "slot_index" && violation.rule.rack === "subsystem" && violation.rule.index === 31 && violation.rule.available === 5));
});

test("T3 rig and service address checks also preserve invalidity when no correction is applied", async () => {
  const rig = type("Medium Hybrid Burst Aerator I").id;
  const result = await simulateWorkbench(fit("Tengu", [{ rack: "rig", index: 31, typeId: rig, state: "online" }]), "en");
  assert.equal(result.valid, false);
  assert.ok(result.violations.some(violation => violation.rule.type === "slot_index" && violation.rule.rack === "rig" && violation.rule.available === 3));
  const service = type("Standup Cloning Center I").id;
  const invalidService = await simulateWorkbench(fit("Tengu", [{ rack: "service", index: 0, typeId: service, state: "online" }]), "en");
  assert.equal(invalidService.valid, false);
  assert.ok(invalidService.violations.some(violation => violation.rule.type === "slot_index" && violation.rule.rack === "service" && violation.rule.available === 0));
  assert.ok(invalidService.violations.some(violation => violation.rule.type === "structure_item"));
});

test("duplicate subsystem families grant no extra layout and retain subsystem and slot conflicts", async () => {
  const duplicated = await simulateWorkbench(fit("Tengu", [subsystem(45601, 0), subsystem(45603, 1), launcher(0)]), "en");
  assert.equal(duplicated.slots.high.limit, 0);
  assert.equal(duplicated.hardpoints.launcher.limit, 0);
  assert.equal(duplicated.engine.compatibilityCorrections, undefined);
  assert.equal(duplicated.valid, false);
  assert.ok(duplicated.violations.some(violation => violation.rule.type === "subsystem_taken"));
  assert.equal(duplicated.moduleStates[0]!.state, "offline");
  const sameSlot = await simulateWorkbench(fit("Tengu", [subsystem(45601, 0), subsystem(45603, 0)]), "en");
  assert.equal(sameSlot.valid, false);
  assert.ok(sameSlot.violations.some(violation => violation.rule.type === "slot_taken"));
  const differentFamilies = await simulateWorkbench(fit("Tengu", [subsystem(45601, 0), subsystem(45589, 0)]), "en");
  assert.equal(differentFamilies.slots.high.limit, 0);
  assert.equal(differentFamilies.slots.medium.limit, 0);
  assert.equal(differentFamilies.hardpoints.launcher.limit, 0);
  assert.equal(differentFamilies.valid, false);
  assert.ok(differentFamilies.violations.some(violation => violation.rule.type === "slot_taken"));
  assert.equal(differentFamilies.moduleStates[0]!.state, "offline");
  assert.equal(differentFamilies.moduleStates[1]!.state, "offline");
});

test("foreign or mis-racked subsystem parts do not manufacture layout or normalize their state", async () => {
  const foreign = await simulateWorkbench(fit("Tengu", [subsystem(type("Loki Offensive - Launcher Efficiency Configuration").id)]), "en");
  assert.equal(foreign.slots.high.limit, 0);
  assert.equal(foreign.engine.compatibilityCorrections, undefined);
  assert.equal(foreign.valid, false);
  assert.ok(foreign.violations.some(violation => violation.rule.type === "ship_restricted"));
  assert.equal(foreign.moduleStates[0]!.state, "offline");
  const wrongRack = await simulateWorkbench(fit("Tengu", [{ ...subsystem(), rack: "high" }]), "en");
  assert.equal(wrongRack.slots.high.limit, 0);
  assert.equal(wrongRack.valid, false);
  assert.ok(wrongRack.violations.some(violation => violation.rule.type === "wrong_slot"));
});

test("missing skills and resource overloads are preserved after layout correction", async () => {
  const untrained = await simulateWorkbench({ ...fit("Tengu", [subsystem(), launcher()]), skillProfile: { mode: "none" } }, "en");
  assert.equal(untrained.slots.high.limit, 7);
  assert.equal(untrained.valid, false);
  assert.ok(untrained.violations.some(violation => violation.rule.type === "skill"));
  const hugeGun = type("425mm Railgun II").id;
  const overfit = await simulateWorkbench(fit("Tengu", [subsystem(45602), ...Array.from({ length: 6 }, (_, index) => ({ rack: "high" as const, index, typeId: hugeGun, state: "online" as const }))]), "en");
  assert.equal(overfit.hardpoints.turret.limit, 6);
  assert.equal(overfit.valid, false);
  assert.ok(overfit.violations.some(violation => violation.rule.type === "resource" && violation.rule.resource === "powergrid"));
});

test("already-correct drone bay and bandwidth from WASM are never added a second time", async () => {
  const result = await simulateWorkbench({ ...fit("Tengu", [subsystem(45603)]), drones: [{ typeId: 2454, quantity: 1, activeQuantity: 1 }] }, "en");
  assert.equal(result.stats.drones.bayCapacity, 50);
  assert.equal(result.stats.drones.bandwidthCapacity, 25);
  assert.equal(result.stats.drones.bayUsed, 5);
  assert.equal(result.stats.drones.bandwidthUsed, 5);
  assert.ok(result.engine.compatibilityCorrections!.every(correction => !/drone|cpu|power/iu.test(correction.attribute)));
});

test("only valid passive subsystems normalize public state while requested state stays unchanged", async () => {
  for (const state of ["offline", "online", "active", "overheated"] as const) {
    const result = await simulateWorkbench(fit("Tengu", [subsystem(45601, 0, state), { rack: "high", index: 0, typeId: type("Small Energy Neutralizer I").id, state: "offline" }]), "en");
    assert.equal(result.moduleStates[0]!.requestedState, state);
    assert.equal(result.moduleStates[0]!.state, "online");
    assert.equal(result.moduleStates[0]!.maxState, "online");
    assert.equal(result.moduleStates[1]!.state, "offline");
    assert.equal(result.fit.slots[0]!.state, state);
  }
});

test("non-T3 hull simulations are not altered by the subsystem compatibility adapter", async () => {
  const ordinary = await simulateWorkbench(fit("Tristan", [subsystem()]), "en");
  assert.equal(ordinary.slots.high.limit, 3);
  assert.equal(ordinary.hardpoints.turret.limit, 2);
  assert.equal(ordinary.engine.compatibilityCorrections, undefined);
  assert.equal(ordinary.valid, false);
  assert.ok(ordinary.violations.some(violation => violation.rule.type === "ship_restricted"));
});

test("an upstream-corrected or partially unexplained layout is not overwritten or double-counted", () => {
  const ship = getFittingType(29984)!;
  const attributes = new Map(Object.entries(ship.attributes).map(([name, base]) => [data.attributeIds[name]!, { base, value: base }]));
  attributes.get(data.attributeIds.hiSlots!)!.value = 7;
  attributes.get(data.attributeIds.launcherSlotsLeft!)!.value = 6;
  const emptyResult = { attributes: new Map(), state: "offline" as const, max_state: "offline" as const, charge: undefined };
  const result: Calculation = { ship: { ...emptyResult, attributes }, character: emptyResult, items: [], violations: [{ target: { type: "ship" }, rule: { type: "resource", resource: "cpu", used: 1000, available: 1 } }] };
  assert.deepEqual(applySubsystemLayoutCompatibility(fit("Tengu", [subsystem()]), result).corrections, []);
  assert.equal(result.ship.attributes.get(data.attributeIds.hiSlots!)!.value, 7);
  assert.equal(result.violations!.length, 1);
  result.ship.attributes.get(data.attributeIds.hiSlots!)!.value = 4;
  assert.deepEqual(applySubsystemLayoutCompatibility(fit("Tengu", [subsystem()]), result).corrections, []);
  assert.equal(result.ship.attributes.get(data.attributeIds.hiSlots!)!.value, 4);
});
