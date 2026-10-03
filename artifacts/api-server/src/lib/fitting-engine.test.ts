import assert from "node:assert/strict";
import { after, test } from "node:test";
import { SimulateFittingWorkbenchResponse } from "@workspace/api-zod";
import { closeFittingEngine, exportEft, parseEft, resolveWorkbenchFit, simulateWorkbench, validateCanonicalFit, type CanonicalFit } from "./fitting-engine";
import { getFittingData, getFittingCatalogItem } from "./fitting-data";

const data = getFittingData();
function id(name: string): number { const found = data.types.find((type) => type.name.en === name); assert.ok(found, name); return found.id; }
function empty(ship = "Rifter"): CanonicalFit { return { schemaVersion: 2, shipTypeId: id(ship), name: "Engine acceptance", slots: [], drones: [], cargo: [], skillProfile: { mode: "all5" }, damageProfile: { em: 0.25, thermal: 0.25, kinetic: 0.25, explosive: 0.25 } }; }
function gun(state: CanonicalFit["slots"][number]["state"] = "active", charge = true): CanonicalFit["slots"][number] { return { rack: "high", index: 0, typeId: id("200mm AutoCannon II"), state, ...(charge ? { chargeTypeId: id("Republic Fleet EMP S") } : {}) }; }
after(closeFittingEngine);

test("pinned catalog covers subsystems, skills, implants, fighters, cargo and Chinese names", () => {
  assert.equal(data.buildNumber, 3561556);
  for (const category of [16, 20, 32, 87]) assert.ok(data.types.some((type) => type.categoryId === category));
  assert.equal(getFittingCatalogItem(id("Tritanium"), "zh")?.name, "三钛合金");
  assert.equal(getFittingCatalogItem(2_000_000_000, "en"), null);
  assert.ok(getFittingCatalogItem(id("200mm AutoCannon II"), "en")?.capabilities?.chargeGroups.length);
});
test("reject malformed data before crossing the WASM boundary while allowing overfitting", () => {
  assert.throws(() => validateCanonicalFit({ ...empty(), shipTypeId: id("Tritanium") }));
  assert.throws(() => validateCanonicalFit({ ...empty(), drones: [{ typeId: id("Hobgoblin II"), quantity: 1, activeQuantity: 2 }] }));
  assert.throws(() => validateCanonicalFit({ ...empty(), slots: [{ ...gun(), typeId: id("Tritanium") }] }));
  assert.throws(() => validateCanonicalFit({ ...empty(), damageProfile: { em: NaN, thermal: 0, kinetic: 0, explosive: 1 } }));
  assert.throws(() => validateCanonicalFit({ ...empty(), slots: [{ ...gun(), state: "mystery" }] }));
  assert.equal(validateCanonicalFit({ ...empty(), slots: Array.from({ length: 4 }, (_, index) => ({ ...gun(), index })) }).slots.length, 4);
});
test("support skills apply independently calculable CPU and powergrid bonuses", async () => {
  const skilled = await simulateWorkbench(empty(), "en");
  const unskilled = await simulateWorkbench({ ...empty(), skillProfile: { mode: "none" } }, "en");
  assert.equal(unskilled.resources.cpu.limit, 130);
  assert.equal(skilled.resources.cpu.limit, 162.5);
  assert.equal(unskilled.resources.powergrid.limit, 41);
  assert.equal(skilled.resources.powergrid.limit, 51.25);
  assert.ok(skilled.defense.shieldHp > unskilled.defense.shieldHp);
  assert.ok(skilled.stats.capacitor.rechargeSeconds > 0);
  assert.ok(skilled.stats.navigation.alignSeconds > 0);
  assert.equal(skilled.stats.capacitor.stable, true);
  assert.equal(skilled.stats.capacitor.secondsToEmpty, null);
});
test("serialized results preserve legacy precision and satisfy the generated workbench contract", async () => {
  const result = await simulateWorkbench({ ...empty(), slots: [gun()] }, "zh");
  const response = JSON.parse(JSON.stringify({ ...result, skillSource: { mode: "all5" } }));
  assert.equal(response.precision, "approximate");
  assert.equal(response.calculationPrecision, "dogma");
  const validated = SimulateFittingWorkbenchResponse.safeParse(response);
  assert.equal(validated.success, true, validated.success ? undefined : JSON.stringify(validated.error.issues));
  assert.ok(response.stats.offense.weapons[0].dps > 0);
});
test("loaded ammunition produces DPS and volley while an empty weapon does not", async () => {
  const loaded = await simulateWorkbench({ ...empty(), slots: [gun()] }, "en");
  const unloaded = await simulateWorkbench({ ...empty(), slots: [gun("active", false)] }, "en");
  assert.ok(loaded.stats.offense.dps > 0);
  assert.ok(loaded.stats.offense.alpha > 0);
  assert.ok(loaded.stats.offense.weapons[0]!.alpha > 0);
  assert.equal(loaded.hardpoints.turret.limit, 3);
  assert.equal(unloaded.stats.offense.dps, 0);
  assert.ok(loaded.stats.offense.sustainedDps < loaded.stats.offense.dps);
});
test("offline and online weapon states stop firing and offline releases CPU and PG", async () => {
  const offline = await simulateWorkbench({ ...empty(), slots: [gun("offline")] }, "zh");
  const online = await simulateWorkbench({ ...empty(), slots: [gun("online")] }, "zh");
  assert.equal(offline.resources.cpu.used, 0);
  assert.equal(offline.resources.powergrid.used, 0);
  assert.equal(offline.stats.offense.dps, 0);
  assert.equal(online.stats.offense.dps, 0);
  assert.ok(online.resources.cpu.used > 0);
  assert.equal(offline.moduleStates[0]!.state, "offline");
});
test("damage modules and heat affect real weapon DPS", async () => {
  const baseline = await simulateWorkbench({ ...empty(), slots: [gun()] }, "en");
  const boosted = await simulateWorkbench({ ...empty(), slots: [gun(), { rack: "low", index: 0, typeId: id("Gyrostabilizer II"), state: "online" }] }, "en");
  const overheated = await simulateWorkbench({ ...empty(), slots: [gun("overheated")] }, "en");
  assert.ok(boosted.stats.offense.dps > baseline.stats.offense.dps);
  assert.ok(overheated.stats.offense.dps > baseline.stats.offense.dps);
});
test("shield extenders and active resistance modules change HP, EHP and resistances", async () => {
  const baseline = await simulateWorkbench(empty(), "en");
  const extender = await simulateWorkbench({ ...empty(), slots: [{ rack: "medium", index: 0, typeId: id("Small Shield Extender II"), state: "online" }] }, "en");
  const hardener = await simulateWorkbench({ ...empty(), slots: [{ rack: "medium", index: 0, typeId: id("Multispectrum Shield Hardener II"), state: "active" }] }, "en");
  assert.ok(extender.defense.shieldHp > baseline.defense.shieldHp);
  assert.ok(extender.stats.defense.ehp > baseline.stats.defense.ehp);
  assert.ok(hardener.stats.defense.shield.resistances.em > baseline.stats.defense.shield.resistances.em);
});
test("carried and active drones are distinct and aggregated once", async () => {
  const carried = await simulateWorkbench({ ...empty("Tristan"), drones: [{ typeId: id("Hobgoblin II"), quantity: 5, activeQuantity: 0 }] }, "en");
  const active = await simulateWorkbench({ ...empty("Tristan"), drones: [{ typeId: id("Hobgoblin II"), quantity: 5, activeQuantity: 3 }] }, "en");
  assert.equal(carried.stats.offense.dps, 0);
  assert.equal(active.stats.drones.active, 3);
  assert.equal(active.stats.drones.bayUsed, 25);
  assert.equal(active.stats.drones.bandwidthUsed, 15);
  assert.ok(active.stats.offense.droneDps > 0);
  assert.equal(active.stats.offense.dps, active.stats.offense.droneDps);
  assert.equal(active.stats.offense.weaponDps, 0);
});
test("invalid ammunition, slots and rig size report usable fitting violations", async () => {
  const mismatch = await simulateWorkbench({ ...empty(), slots: [{ ...gun(), chargeTypeId: id("Inferno Light Missile") }] }, "en");
  assert.ok(mismatch.violations.some((v) => v.rule.type === "charge_group"));
  const overfit = await simulateWorkbench({ ...empty(), slots: Array.from({ length: 4 }, (_, index) => ({ ...gun(), index })) }, "en");
  assert.equal(overfit.valid, false);
  assert.equal(overfit.slots.high.overloaded, true);
  assert.ok(overfit.violations.some((v) => v.rule.type === "slots"));
  const rig = await simulateWorkbench({ ...empty(), slots: [{ rack: "rig", index: 0, typeId: id("Large Core Defense Field Extender I"), state: "online" }] }, "en");
  assert.ok(rig.violations.some((v) => v.rule.type === "rig_size"));
});
test("propulsion changes velocity and active capacitor demand", async () => {
  const baseline = await simulateWorkbench(empty(), "en");
  const active = await simulateWorkbench({ ...empty(), slots: [{ rack: "medium", index: 0, typeId: id("1MN Afterburner II"), state: "active" }] }, "en");
  assert.ok(active.stats.navigation.speed > baseline.stats.navigation.speed);
  assert.ok(active.stats.capacitor.usage > baseline.stats.capacitor.usage);
});
test("resistance stacking penalties prevent two modules receiving two full bonuses", async () => {
  const slot = { rack: "medium" as const, index: 0, typeId: id("Multispectrum Shield Hardener II"), state: "active" as const };
  const single = await simulateWorkbench({ ...empty(), slots: [slot] }, "en");
  const double = await simulateWorkbench({ ...empty(), slots: [slot, { ...slot, index: 1 }] }, "en");
  const first = single.stats.defense.shield.resistances.em;
  const combined = double.stats.defense.shield.resistances.em;
  assert.ok(combined > first);
  assert.ok(combined < 1 - (1 - first) ** 2);
});
test("tactical modes change ship values and cannot be used on another hull", async () => {
  const defense = await simulateWorkbench(empty("Confessor"), "en");
  assert.equal(defense.fit.modeTypeId, id("Confessor Defense Mode"));
  const propulsion = await simulateWorkbench({ ...empty("Confessor"), modeTypeId: id("Confessor Propulsion Mode") }, "en");
  assert.ok(defense.stats.defense.ehp > propulsion.stats.defense.ehp);
  assert.ok(propulsion.stats.navigation.alignSeconds < defense.stats.navigation.alignSeconds);
  assert.throws(() => validateCanonicalFit({ ...empty(), modeTypeId: id("Confessor Defense Mode") }));
});
test("structure service racks are available and arbitrary cargo consumes actual volume", async () => {
  const structure = await simulateWorkbench({ ...empty("Astrahus"), slots: [{ rack: "service", index: 0, typeId: id("Standup Cloning Center I"), state: "online" }] }, "en");
  assert.ok(structure.slots.service.limit > 0);
  assert.equal(structure.slots.service.used, 1);
  const cargo = await simulateWorkbench({ ...empty(), cargo: [{ typeId: id("Tritanium"), quantity: 100 }] }, "en");
  assert.equal(cargo.stats.cargo.used, 1);
  assert.equal(cargo.stats.cargo.capacity, 140);
});
test("EFT round-trip preserves independent identical guns, ammunition and offline modules", async () => {
  const fit = { ...empty(), slots: [gun(), { ...gun("offline"), index: 2 }], cargo: [{ typeId: id("Tritanium"), quantity: 100 }] };
  const exported = await exportEft(fit);
  assert.ok(exported.text.includes("Republic Fleet EMP S"));
  const imported = await parseEft(exported.text);
  assert.deepEqual(imported.fit.slots.map((slot) => [slot.index, slot.typeId, slot.chargeTypeId, slot.state]), [[0, gun().typeId, gun().chargeTypeId, "active"], [2, gun().typeId, gun().chargeTypeId, "offline"]]);
  assert.deepEqual(imported.fit.cargo, fit.cargo);
});
test("Chinese EFT names are read from the same official SDE version", async () => {
  const ship = getFittingCatalogItem(id("Rifter"), "zh")!;
  const module = getFittingCatalogItem(id("200mm AutoCannon II"), "zh")!;
  const charge = getFittingCatalogItem(id("Republic Fleet EMP S"), "zh")!;
  const imported = await parseEft(`[${ship.name}, 中文导入]\n${module.name}, ${charge.name}\n`);
  assert.equal(imported.fit.shipTypeId, ship.typeId);
  assert.equal(imported.fit.slots[0]?.typeId, module.typeId);
  assert.equal(imported.fit.slots[0]?.chargeTypeId, charge.typeId);
  await assert.rejects(parseEft("[Rifter, Invalid]\nDefinitely not a module\n"));
  const tagged = await parseEft("[Rifter, [PVP] doctrine]\n200mm AutoCannon II, Republic Fleet EMP S\n");
  assert.equal(tagged.fit.name, "[PVP] doctrine");
  assert.ok((await exportEft(tagged.fit)).text.startsWith("[Rifter, [PVP] doctrine]"));
});
test("legacy quantity list remains supported and common invalid skill profiles are rejected", async () => {
  const fit = resolveWorkbenchFit({ shipId: id("Rifter"), modules: [{ typeId: id("200mm AutoCannon II"), quantity: 2 }] });
  assert.equal(fit.slots.length, 2);
  await assert.rejects(simulateWorkbench({ ...empty(), skillProfile: { mode: "character", characterId: 1 } }, "en"));
});
test("bounded queue rejects extra work without crashing the next calculation", async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => simulateWorkbench(empty(), "en")));
  assert.ok(results.some((result) => result.status === "rejected"));
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.equal((await simulateWorkbench(empty(), "en")).ship.typeId, id("Rifter"));
});
