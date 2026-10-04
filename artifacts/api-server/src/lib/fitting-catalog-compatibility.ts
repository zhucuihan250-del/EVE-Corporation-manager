import type { FittingCategory, FittingType } from "./fitting-data";
import { FittingWorkbenchError } from "./fitting-workbench-errors";

const STRUCTURE_CATEGORY = 65;
const STRUCTURE_MODULE_CATEGORY = 66;
// Match EVEShipFit Dogma 13.1's hard capital-module rule, not an item's name,
// weapon size or its CPU/PG demand. Capital rigs use rigSize separately.
const CAPITAL_MODULE_VOLUME = 3500;
const RACK_ATTRIBUTES: Record<string, string> = {
  high: "hiSlots", medium: "medSlots", low: "lowSlots", rig: "rigSlots", service: "serviceSlots",
};
const SUBSYSTEM_MODIFIERS: Record<string, string> = {
  hiSlots: "hiSlotModifier", medSlots: "medSlotModifier", lowSlots: "lowSlotModifier",
  turretSlotsLeft: "turretHardPointModifier", launcherSlotsLeft: "launcherHardPointModifier",
  droneCapacity: "droneCapacity", droneBandwidth: "droneBandwidth",
};
const FIGHTER_ROLES = ["Light", "Support", "Heavy"] as const;

function invalidContext(message: string): never {
  throw new FittingWorkbenchError(400, "FITTING_INVALID_CATALOG_CONTEXT", message);
}

function attribute(type: FittingType, name: string): number {
  return type.attributes[name] ?? 0;
}

function volume(type: FittingType): number {
  return type.attributes.volume ?? type.volume ?? 0;
}

function allowedOnHull(item: FittingType, ship: FittingType): boolean {
  const allowedTypes = Object.entries(item.attributes).filter(([name, value]) => value > 0 && (name === "fitsToShipType" || /^canFitShipType(?:[1-9]|1[0-2])$/u.test(name))).map(([, value]) => value);
  const allowedGroups = Object.entries(item.attributes).filter(([name, value]) => value > 0 && /^canFitShipGroup(?:0[1-9]|1[0-9]|20)$/u.test(name)).map(([, value]) => value);
  // A type and a group restriction form one OR whitelist in Dogma.
  return (!allowedTypes.length && !allowedGroups.length) || allowedTypes.includes(ship.id) || allowedGroups.includes(ship.groupId);
}

function isStandupFighter(type: FittingType): boolean {
  return FIGHTER_ROLES.some(role => attribute(type, `fighterSquadronIsStandup${role}`) !== 0);
}

export function chargeFitsModule(charge: FittingType, module: FittingType): boolean {
  const groups = [1, 2, 3, 4, 5].map(index => attribute(module, `chargeGroup${index}`)).filter(group => group > 0);
  // No chargeGroups means there is no loadable ammo browser for this item.
  // Civilian weapons and modules which generate their own ammunition remain
  // usable; this does not reject them from the equipment catalog.
  if (!groups.includes(charge.groupId)) return false;
  const moduleSize = module.attributes.chargeSize, chargeSize = charge.attributes.chargeSize;
  if (moduleSize !== undefined && chargeSize !== undefined && moduleSize !== chargeSize) return false;
  const capacity = module.attributes.capacity ?? module.capacity;
  // Some civilian guns have no capacity entry. Do not invent a zero limit.
  return capacity === undefined || volume(charge) <= capacity + 1e-9;
}

/** A hull eligibility filter only. Existing occupied slots, fitting resources,
 * trained skills and group counts are deliberately not applied: the browser
 * must still offer replacements, offline modules and deliberate overfits. */
export function createCatalogCompatibility(options: {
  ship?: FittingType;
  types: readonly FittingType[];
  categoryOf(type: FittingType): FittingCategory;
  subsystemTypeIds?: readonly number[];
  chargeForType?: FittingType;
}): (type: FittingType) => boolean {
  const { ship, types, categoryOf, chargeForType } = options;
  if (options.subsystemTypeIds !== undefined && !ship) invalidContext("指定子系统时须同时指定舰船。");
  if (chargeForType && !["module", "subsystem"].includes(categoryOf(chargeForType))) invalidContext("弹药筛选目标须为已装配模块。");

  const hullAttributes = { ...ship?.attributes };
  if (ship) {
    const byId = new Map(types.map(type => [type.id, type]));
    let subsystems: FittingType[];
    if (options.subsystemTypeIds !== undefined) {
      if (options.subsystemTypeIds.length > 5) invalidContext("一次最多指定 5 个子系统。");
      const families = new Set<number>();
      subsystems = options.subsystemTypeIds.map(id => {
        const type = byId.get(id);
        if (!type || categoryOf(type) !== "subsystem" || type.slot !== "subsystem" || attribute(type, "fitsToShipType") !== ship.id) invalidContext("子系统不适用于当前舰船。");
        const family = attribute(type, "subSystemSlot") || type.groupId;
        if (families.has(family)) invalidContext("同类子系统不能重复指定。");
        families.add(family);
        return type;
      });
    } else {
      // Older callers only supply a hull. T3 hulls start at zero slots, so use
      // the capabilities obtainable with that hull's legal subsystem families
      // instead of hiding every gun, launcher and drone before choosing one.
      subsystems = types.filter(type => type.published && categoryOf(type) === "subsystem" && attribute(type, "fitsToShipType") === ship.id);
    }
    for (const [hullAttribute, modifierAttribute] of Object.entries(SUBSYSTEM_MODIFIERS)) {
      let modifier = 0;
      if (options.subsystemTypeIds !== undefined) modifier = subsystems.reduce((sum, type) => sum + attribute(type, modifierAttribute), 0);
      else {
        const maxima = new Map<number, number>();
        for (const type of subsystems) {
          const family = attribute(type, "subSystemSlot") || type.groupId;
          maxima.set(family, Math.max(maxima.get(family) ?? 0, attribute(type, modifierAttribute)));
        }
        modifier = [...maxima.values()].reduce((sum, value) => sum + value, 0);
      }
      hullAttributes[hullAttribute] = (hullAttributes[hullAttribute] ?? 0) + modifier;
    }
  }

  const hullAllows = (type: FittingType): boolean => {
    if (!ship) return true;
    const category = categoryOf(type), structure = ship.categoryId === STRUCTURE_CATEGORY;
    if (!["module", "subsystem", "drone", "fighter"].includes(category)) return true;
    if (!allowedOnHull(type, ship)) return false;
    if (category === "module" || category === "subsystem") {
      if (structure !== (type.categoryId === STRUCTURE_MODULE_CATEGORY)) return false;
      if (type.slot === "subsystem") return attribute(type, "fitsToShipType") === ship.id && attribute(ship, "maxSubSystems") > 0;
      const rackAttribute = RACK_ATTRIBUTES[type.slot];
      if (!rackAttribute || (hullAttributes[rackAttribute] ?? 0) <= 0) return false;
      if (type.slot === "rig" && type.attributes.rigSize !== undefined && ship.attributes.rigSize !== undefined && type.attributes.rigSize !== ship.attributes.rigSize) return false;
      if (!structure && !attribute(ship, "isCapitalSize") && type.slot !== "rig" && volume(type) > CAPITAL_MODULE_VOLUME) return false;
      if (type.hardpoint && (hullAttributes[type.hardpoint === "turret" ? "turretSlotsLeft" : "launcherSlotsLeft"] ?? 0) <= 0) return false;
      return true;
    }
    if (category === "drone") {
      if (structure) return false;
      return (hullAttributes.droneCapacity ?? 0) > 0 && volume(type) <= (hullAttributes.droneCapacity ?? 0)
        && attribute(type, "droneBandwidthUsed") <= (hullAttributes.droneBandwidth ?? 0);
    }
    if (structure !== isStandupFighter(type)) return false;
    if ((hullAttributes.fighterCapacity ?? 0) <= 0 || volume(type) > (hullAttributes.fighterCapacity ?? 0) || (hullAttributes.fighterTubes ?? 0) <= 0) return false;
    return FIGHTER_ROLES.some(role => attribute(type, `fighterSquadronIs${structure ? "Standup" : ""}${role}`) !== 0
      && (hullAttributes[`fighter${structure ? "Standup" : ""}${role}Slots`] ?? 0) > 0);
  };

  const modulesByChargeGroup = new Map<number, FittingType[]>();
  const chargeModules = chargeForType ? [chargeForType] : types;
  for (const module of chargeModules) {
    if ((!chargeForType && !module.published) || !["module", "subsystem"].includes(categoryOf(module)) || !hullAllows(module)) continue;
    for (let index = 1; index <= 5; index++) {
      const group = attribute(module, `chargeGroup${index}`);
      if (group <= 0) continue;
      const candidates = modulesByChargeGroup.get(group) ?? [];
      candidates.push(module);
      modulesByChargeGroup.set(group, candidates);
    }
  }
  return type => categoryOf(type) === "charge"
    ? (modulesByChargeGroup.get(type.groupId) ?? []).some(module => chargeFitsModule(type, module))
    : hullAllows(type);
}
