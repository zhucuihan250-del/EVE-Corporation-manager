import assert from "node:assert/strict";
import test from "node:test";
import { categoryOf, getFittingData, getFittingType, searchFittingCatalog, type FittingCatalogOptions, type FittingType } from "./fitting-data";
import { chargeFitsModule, createCatalogCompatibility } from "./fitting-catalog-compatibility";
import { FittingWorkbenchError } from "./fitting-workbench-errors";

const data = getFittingData();
function type(name: string): FittingType {
  const item = data.types.find(item => item.name.en === name);
  assert.ok(item, `SDE contains ${name}`);
  return item;
}
function includes(name: string, options: Partial<FittingCatalogOptions> = {}): boolean {
  const item = type(name);
  return searchFittingCatalog({ query: name, category: categoryOf(item), language: "en", limit: 100, ...options }).items.some(row => row.typeId === item.id);
}
function accepts(shipName: string, subsystemTypeIds?: number[]) {
  return createCatalogCompatibility({ ship: type(shipName), types: data.types, categoryOf, subsystemTypeIds });
}

test("catalog without hull context retains its backward-compatible unrestricted search", () => {
  assert.equal(includes("Capital Shield Booster I"), true);
  assert.equal(includes("Medium Hybrid Burst Aerator I"), true);
  assert.equal(includes("Standup Templar I"), true);
});

test("rig filters use exact rigSize rather than guessed ship mass", () => {
  assert.equal(includes("Small Hybrid Burst Aerator I", { shipTypeId: 593 }), true);
  assert.equal(includes("Medium Hybrid Burst Aerator I", { shipTypeId: 593 }), false);
  assert.equal(includes("Capital Hybrid Burst Aerator I", { shipTypeId: 593 }), false);
  assert.equal(includes("Medium Hybrid Burst Aerator I", { shipTypeId: 29984 }), true);
  assert.equal(includes("Capital Hybrid Burst Aerator I", { shipTypeId: 19726 }), true);
});

test("a zero launcher hardpoint hull hides launchers but keeps utility high-slot modules", () => {
  assert.equal(includes("Heavy Missile Launcher I", { shipTypeId: 593 }), false);
  assert.equal(includes("Small Energy Neutralizer I", { shipTypeId: 593 }), true);
  assert.equal(includes("Heavy Missile Launcher I", { shipTypeId: 638 }), true);
});

test("hull-specific module restrictions include group and individual type whitelists", () => {
  assert.equal(includes("Bastion Module I", { shipTypeId: 593 }), false);
  assert.equal(includes("Bastion Module I", { shipTypeId: 28659 }), true);
  assert.equal(includes("Covert Ops Cloaking Device II", { shipTypeId: 593 }), false);
  assert.equal(includes("Covert Ops Cloaking Device II", { shipTypeId: 12034 }), true);
});

test("canFitShipGroup20 and canFitShipType12 use OR, not AND, semantics", () => {
  const ship = type("Tristan");
  const module: FittingType = { ...type("Small Energy Neutralizer I"), attributes: { canFitShipGroup20: ship.groupId, canFitShipType12: 999999 } };
  const filter = createCatalogCompatibility({ ship, types: [ship, module], categoryOf });
  assert.equal(filter(module), true);
  assert.equal(filter({ ...module, attributes: { canFitShipGroup20: 999998, canFitShipType12: ship.id } }), true);
  assert.equal(filter({ ...module, attributes: { canFitShipGroup20: 999998, canFitShipType12: 999999 } }), false);
});

test("capital modules match the installed Dogma volume boundary; rigs are handled separately", () => {
  assert.equal(includes("Capital Shield Booster I", { shipTypeId: 587 }), false);
  assert.equal(includes("Capital Shield Booster I", { shipTypeId: 19726 }), true);
  const ship = type("Tristan"), base = type("Small Energy Neutralizer I");
  const filter = createCatalogCompatibility({ ship, types: [ship, base], categoryOf });
  assert.equal(filter({ ...base, volume: 3500 }), true);
  assert.equal(filter({ ...base, volume: 3500.1 }), false);
});

test("resource and weapon-size preferences do not hide legally overfitted equipment", () => {
  assert.equal(includes("10MN Afterburner I", { shipTypeId: 593 }), true);
  assert.equal(includes("Heavy Neutron Blaster II", { shipTypeId: 593 }), true);
  assert.equal(includes("Torpedo Launcher I", { shipTypeId: 12034 }), true);
});

test("structure and ship modules are never intermixed, including service modules", () => {
  assert.equal(includes("Standup Focused Warp Disruptor I", { shipTypeId: 593 }), false);
  assert.equal(includes("Standup Focused Warp Disruptor I", { shipTypeId: 35832 }), true);
  assert.equal(includes("Small Energy Neutralizer I", { shipTypeId: 35832 }), false);
  const service = data.types.find(item => item.published && item.categoryId === 66 && item.slot === "service" && (!item.attributes.canFitShipGroup01 || item.attributes.canFitShipGroup01 === 1657));
  assert.ok(service);
  assert.equal(accepts("Tristan")(service), false);
});

test("subsystem search keeps only the exact strategic cruiser family", () => {
  const items = searchFittingCatalog({ category: "subsystem", shipTypeId: 29984, language: "en", limit: 100 }).items;
  assert.ok(items.length >= 12);
  assert.ok(items.every(item => getFittingType(item.typeId)!.attributes.fitsToShipType === 29984));
  assert.deepEqual(searchFittingCatalog({ category: "subsystem", shipTypeId: 593, language: "en" }).items, []);
});

test("T3 hull-only callers retain potential slots, hardpoints and drone capabilities", () => {
  assert.equal(includes("Heavy Missile Launcher I", { shipTypeId: 29984 }), true);
  assert.equal(includes("Heavy Neutron Blaster II", { shipTypeId: 29984 }), true);
  assert.equal(includes("Hobgoblin I", { shipTypeId: 29984 }), true);
});

test("explicit T3 subsystem context tracks current rack and hardpoint capabilities", () => {
  assert.equal(includes("Heavy Missile Launcher I", { shipTypeId: 29984, subsystemTypeIds: [] }), false);
  const missile = type("Tengu Offensive - Accelerated Ejection Bay").id;
  const hybrid = type("Tengu Offensive - Magnetic Infusion Basin").id;
  assert.equal(includes("Heavy Missile Launcher I", { shipTypeId: 29984, subsystemTypeIds: [missile] }), true);
  assert.equal(includes("Heavy Neutron Blaster II", { shipTypeId: 29984, subsystemTypeIds: [missile] }), false);
  assert.equal(includes("Heavy Neutron Blaster II", { shipTypeId: 29984, subsystemTypeIds: [hybrid] }), true);
  assert.equal(includes("Heavy Missile Launcher I", { shipTypeId: 29984, subsystemTypeIds: [hybrid] }), false);
});

test("explicit T3 subsystem context tracks drone bay and bandwidth without duplicate-family inflation", () => {
  const missile = type("Tengu Offensive - Accelerated Ejection Bay").id;
  const support = type("Tengu Offensive - Support Processor").id;
  assert.equal(includes("Hobgoblin I", { shipTypeId: 29984, subsystemTypeIds: [missile] }), false);
  assert.equal(includes("Hobgoblin I", { shipTypeId: 29984, subsystemTypeIds: [support] }), true);
  for (const subsystemTypeIds of [[missile, support], [missile, missile], [2454], [45601, 45601, 45601, 45601, 45601, 45601]]) {
    assert.throws(() => searchFittingCatalog({ shipTypeId: 29984, subsystemTypeIds, language: "en" }), error => error instanceof FittingWorkbenchError && error.code === "FITTING_INVALID_CATALOG_CONTEXT");
  }
});

test("drone equipment is limited to usable individual bay and bandwidth capabilities", () => {
  assert.equal(includes("Hobgoblin I", { shipTypeId: 593 }), true);
  assert.equal(includes("Ogre I", { shipTypeId: 593 }), true);
  assert.equal(includes("Hobgoblin I", { shipTypeId: 601 }), true);
  assert.equal(includes("Ogre I", { shipTypeId: 601 }), false);
  assert.equal(includes("Hobgoblin I", { shipTypeId: 4302 }), false);
});

test("fighter roles and Standup fighter markers use the hull's actual launch tubes", () => {
  const carrier = accepts("Thanatos"), supercarrier = accepts("Nyx"), structure = accepts("Astrahus");
  assert.equal(carrier(type("Templar I")), true);
  assert.equal(carrier(type("Dromi I")), true);
  assert.equal(carrier(type("Malleus I")), false);
  assert.equal(supercarrier(type("Malleus I")), true);
  assert.equal(supercarrier(type("Dromi I")), false);
  assert.equal(carrier(type("Standup Templar I")), false);
  assert.equal(structure(type("Templar I")), false);
  assert.equal(structure(type("Standup Templar I")), true);
  assert.equal(accepts("Tristan")(type("Templar I")), false);
});

test("loaded ammunition filtering uses groups, sizes and single-charge capacity", () => {
  assert.equal(chargeFitsModule(type("Antimatter Charge M"), type("Heavy Neutron Blaster II")), true);
  assert.equal(chargeFitsModule(type("Antimatter Charge S"), type("Heavy Neutron Blaster II")), false);
  assert.equal(chargeFitsModule(type("Scourge Heavy Missile"), type("Heavy Missile Launcher I")), true);
  assert.equal(chargeFitsModule(type("Scourge Torpedo"), type("Heavy Missile Launcher I")), false);
  assert.equal(chargeFitsModule(type("Scourge Torpedo"), type("Torpedo Launcher I")), true);
  assert.equal(chargeFitsModule(type("Cap Booster 800"), type("Small Capacitor Booster I")), false);
});

test("chargeForTypeId also checks the chosen weapon belongs on this hull", () => {
  assert.equal(includes("Scourge Heavy Missile", { shipTypeId: 638, chargeForTypeId: 501 }), true);
  assert.equal(includes("Scourge Torpedo", { shipTypeId: 638, chargeForTypeId: 501 }), false);
  assert.equal(includes("Scourge Heavy Missile", { shipTypeId: 593, chargeForTypeId: 501 }), false);
  assert.equal(includes("Antimatter Charge S", { shipTypeId: 593, chargeForTypeId: 3146 }), false);
});

test("hull-only ammunition follows its compatible weapons rather than all ammunition", () => {
  assert.equal(includes("Scourge Heavy Missile", { shipTypeId: 593 }), false);
  assert.equal(includes("Antimatter Charge S", { shipTypeId: 593 }), true);
  assert.equal(includes("Scourge Torpedo", { shipTypeId: 12034 }), true);
});

test("cargo and pilot items are not given artificial ship-fitting restrictions", () => {
  assert.equal(includes("Mobile Tractor Unit", { shipTypeId: 593 }), true);
  const pilot = data.types.find(item => item.published && categoryOf(item) === "implant");
  assert.ok(pilot);
  assert.equal(accepts("Tristan")(pilot), true);
  assert.equal(accepts("Astrahus")(pilot), true);
});

test("compatibility filtering happens before the catalog result limit", () => {
  const results = searchFittingCatalog({ category: "module", slot: "rig", shipTypeId: 593, language: "en", limit: 100 }).items;
  assert.equal(results.length, 100);
  assert.ok(results.every(item => item.capabilities?.rigSize === 1));
});

test("invalid hull or module context is rejected without changing exact-id resolution", () => {
  for (const options of [{ shipTypeId: 34 }, { shipTypeId: 999999999 }, { chargeForTypeId: 34 }, { chargeForTypeId: 999999999 }, { subsystemTypeIds: [] }]) {
    assert.throws(() => searchFittingCatalog({ ...options, language: "en" }), error => error instanceof FittingWorkbenchError && error.code === "FITTING_INVALID_CATALOG_CONTEXT");
  }
  assert.equal(getFittingType(20703)?.name.en, "Capital Shield Booster I");
});
