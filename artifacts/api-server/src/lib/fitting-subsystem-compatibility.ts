import type { Calculation } from "@eveshipfit/dogma-engine";
import { getFittingData, getFittingType, type FittingType } from "./fitting-data";
import type { CanonicalFit, WorkbenchCompatibilityCorrection, WorkbenchViolation } from "./fitting-engine-types";

const PINNED_SDE_BUILD = 3561556;
const LAYOUT = [
  ["high", "hiSlots", "hiSlotModifier", "slotModifier"],
  ["medium", "medSlots", "medSlotModifier", "slotModifier"],
  ["low", "lowSlots", "lowSlotModifier", "slotModifier"],
  ["turret", "turretSlotsLeft", "turretHardPointModifier", "hardPointModifierEffect"],
  ["launcher", "launcherSlotsLeft", "launcherHardPointModifier", "hardPointModifierEffect"],
] as const;
const RACK_LIMITS = { high: "hiSlots", medium: "medSlots", low: "lowSlots", rig: "rigSlots", subsystem: "maxSubSystems", service: "serviceSlots" } as const;

/** The pinned 13.1 WASM/SDE leaves effects 3773 and 3774 with no modifiers.
 * Repair only their five static layout attributes. CPU/PG, drone capacity,
 * skill effects, state calculations and all other validation remain Dogma's.
 * The public engine metadata names every applied correction explicitly. */
export function applySubsystemLayoutCompatibility(fit: CanonicalFit, calculation: Calculation): {
  corrections: WorkbenchCompatibilityCorrection[];
  passiveSubsystemIndexes: Set<number>;
  additionalViolations: WorkbenchViolation[];
} {
  const corrections: WorkbenchCompatibilityCorrection[] = [];
  const passiveSubsystemIndexes = new Set<number>();
  const additionalViolations: WorkbenchViolation[] = [];
  const data = getFittingData(), ship = getFittingType(fit.shipTypeId);
  if (data.buildNumber !== PINNED_SDE_BUILD || !ship || ship.categoryId !== 6 || ship.groupId !== 963) return { corrections, passiveSubsystemIndexes, additionalViolations };

  const families = new Map<number, Array<{ index: number; type: FittingType }>>();
  const addresses = new Map<number, number>();
  for (const slot of fit.slots) if (slot.rack === "subsystem") addresses.set(slot.index, (addresses.get(slot.index) ?? 0) + 1);
  fit.slots.forEach((slot, index) => {
    if (slot.rack !== "subsystem") return;
    const type = getFittingType(slot.typeId);
    if (!type || type.categoryId !== 32 || type.slot !== "subsystem" || type.attributes.fitsToShipType !== ship.id) return;
    const family = type.attributes.subSystemSlot;
    if (!Number.isSafeInteger(family) || family <= 0) return;
    const members = families.get(family) ?? [];
    members.push({ index, type });
    families.set(family, members);
  });
  // Neither a foreign subsystem nor two parts of one family may manufacture
  // extra slots. Their original ship_restricted/subsystem_taken rules remain.
  const eligible = [...families.values()].filter(members => members.length === 1).flat().filter(entry => {
    const address = fit.slots[entry.index]!.index;
    return address < (ship.attributes.maxSubSystems ?? 0) && addresses.get(address) === 1;
  });
  for (const entry of eligible) {
    if (entry.type.effectCategories?.length && entry.type.effectCategories.every(category => category === 0)) passiveSubsystemIndexes.add(entry.index);
  }

  for (const [slot, attributeName, modifierName, effectName] of LAYOUT) {
    const sources = eligible.filter(entry => entry.type.effects.includes(effectName) && (entry.type.attributes[modifierName] ?? 0) !== 0);
    const modifier = sources.reduce((sum, entry) => sum + (entry.type.attributes[modifierName] ?? 0), 0);
    const attributeId = data.attributeIds[attributeName], base = ship.attributes[attributeName] ?? 0;
    if (!Number.isSafeInteger(attributeId) || attributeId <= 0) continue;
    const original = calculation.ship.attributes.get(attributeId);
    const engineValue = original?.value ?? 0, expected = base + modifier;
    // Do not double-apply a fixed upstream version or replace an unexplained
    // calculated value. This adapter only repairs the known absent effect.
    if (!sources.length || expected === engineValue || engineValue !== base || !Number.isSafeInteger(expected) || expected < 0) continue;
    calculation.ship.attributes.set(attributeId, { ...original, base: original?.base ?? base, value: expected });
    corrections.push({ code: "t3_subsystem_layout", attribute: attributeName, engineValue, correctedValue: expected,
      sourceTypeIds: sources.map(source => source.type.id), sdeBuildNumber: PINNED_SDE_BUILD });

    calculation.violations = (calculation.violations ?? []).filter(violation => !(violation.target.type === "ship" && violation.rule.type === "slots" && violation.rule.slot === slot));
    const used = slot === "turret" || slot === "launcher"
      ? fit.slots.filter(item => getFittingType(item.typeId)?.hardpoint === slot).length
      : fit.slots.filter(item => item.rack === slot).length;
    if (used > expected) calculation.violations.push({ target: { type: "ship" }, rule: { type: "slots", slot, used, available: expected } });
  }
  // Count checks alone do not reject a single item addressed to a nonexistent
  // slot. Check every T3 rack, even when no layout correction was eligible.
  fit.slots.forEach((item, index) => {
    const name = RACK_LIMITS[item.rack], attributeId = data.attributeIds[name];
    const calculated = Number.isSafeInteger(attributeId) && attributeId > 0 ? calculation.ship.attributes.get(attributeId)?.value : undefined;
    const available = Math.max(0, Math.floor(typeof calculated === "number" && Number.isFinite(calculated) ? calculated : ship.attributes[name] ?? 0));
    if (item.index >= available) additionalViolations.push({ target: { type: "item", index }, rule: { type: "slot_index", rack: item.rack, index: item.index, available }, message: "" });
  });
  return { corrections, passiveSubsystemIndexes, additionalViolations };
}
