import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Calculation, Fit, FitItem, ItemResult, State } from "@eveshipfit/dogma-engine";
import { categoryOf, getFittingCatalogItem, getFittingData, getFittingType, type FittingLanguage, type FittingType } from "./fitting-data";
import type { CanonicalFit, WorkbenchEftResult, WorkbenchExportResult, WorkbenchMetric, WorkbenchRack, WorkbenchResource, WorkbenchSimulation, WorkbenchState, WorkbenchViolation } from "./fitting-engine-types";
import { applySubsystemLayoutCompatibility } from "./fitting-subsystem-compatibility";
export type * from "./fitting-engine-types";

const RACKS = new Set(["high", "medium", "low", "rig", "subsystem", "service"]);
const STATES = new Set(["offline", "online", "active", "overheated"]);
const MAX_ITEMS = 256;
const MAX_QUEUE = 8;
const require = createRequire(import.meta.url);
const UNIFORM = { em: 0.25, thermal: 0.25, kinetic: 0.25, explosive: 0.25 };
export class FittingInputError extends Error {
  constructor(public code: string, message: string, public status = 400) { super(message); this.name = "FittingInputError"; }
}
function invalid(message: string): never { throw new FittingInputError("INVALID_FITTING", message); }
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, label: string, min = 1, max = 1_000_000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) invalid(`${label} is invalid`);
  return value;
}
function list(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid(`${label} exceeds ${MAX_ITEMS} items`);
  return value;
}
function itemType(value: unknown, label: string): FittingType {
  const id = integer(value, label, 1, 2_147_483_647);
  const type = getFittingType(id);
  if (!type) invalid(`${label}: unknown item ${id}`);
  return type;
}
export function validateCanonicalFit(value: unknown): CanonicalFit {
  const input = object(value, "Fit");
  if (input.schemaVersion !== 2) invalid("Unsupported fitting format");
  const ship = itemType(input.shipTypeId, "Ship");
  if (categoryOf(ship) !== "ship") invalid("The selected item is not a ship");
  const name = input.name === undefined ? ship.name.en : input.name;
  if (typeof name !== "string" || name.length > 100 || /[\r\n\u0000]/u.test(name)) invalid("Fit name is invalid");
  const slots = list(input.slots, "Slots").map((entry) => {
    const slot = object(entry, "Slot");
    if (!RACKS.has(String(slot.rack))) invalid("Unknown slot rack");
    if (!STATES.has(String(slot.state))) invalid("Unknown module state");
    const type = itemType(slot.typeId, "Module");
    if (!["module", "subsystem"].includes(categoryOf(type))) invalid(`Item ${type.id} cannot be fitted as a module`);
    const result: CanonicalFit["slots"][number] = {
      rack: slot.rack as WorkbenchRack, index: integer(slot.index, "Slot index", 0, 31),
      typeId: type.id, state: slot.state as WorkbenchState,
    };
    if (slot.chargeTypeId !== undefined) {
      const charge = itemType(slot.chargeTypeId, "Charge");
      if (categoryOf(charge) !== "charge") invalid(`Item ${charge.id} is not ammunition or a script`);
      result.chargeTypeId = charge.id;
      if (slot.chargeQuantity !== undefined) result.chargeQuantity = integer(slot.chargeQuantity, "Charge quantity", 1, 1_000_000);
    } else if (slot.chargeQuantity !== undefined) invalid("Charge quantity requires a loaded charge");
    return result;
  });
  const drones = list(input.drones, "Drones").map((entry) => {
    const drone = object(entry, "Drone");
    const type = itemType(drone.typeId, "Drone");
    if (!["drone", "fighter"].includes(categoryOf(type))) invalid(`Item ${type.id} is not a drone or fighter`);
    const quantity = integer(drone.quantity, "Drone quantity", 1, 1000);
    return { typeId: type.id, quantity, activeQuantity: integer(drone.activeQuantity ?? 0, "Active drone quantity", 0, quantity) };
  });
  const cargo = list(input.cargo, "Cargo").map((entry) => {
    const item = object(entry, "Cargo item");
    return { typeId: itemType(item.typeId, "Cargo item").id, quantity: integer(item.quantity, "Cargo quantity", 1, 1_000_000) };
  });
  const implants = list(input.implants, "Implants").map((entry) => {
    const type = itemType(object(entry, "Implant").typeId, "Implant");
    if (categoryOf(type) !== "implant") invalid(`Item ${type.id} is not an implant`);
    return { typeId: type.id };
  });
  const boosters = list(input.boosters, "Boosters").map((entry) => {
    const type = itemType(object(entry, "Booster").typeId, "Booster");
    if (categoryOf(type) !== "booster") invalid(`Item ${type.id} is not a booster`);
    return { typeId: type.id };
  });
  if (slots.length + drones.length * 2 + cargo.length + implants.length + boosters.length > MAX_ITEMS) invalid("Too many fitting items");
  const profile = object(input.skillProfile ?? { mode: "all5" }, "Skill profile");
  if (!["all5", "none", "character"].includes(String(profile.mode))) invalid("Unknown skill profile");
  const skillProfile: CanonicalFit["skillProfile"] = { mode: profile.mode as CanonicalFit["skillProfile"]["mode"] };
  if (profile.mode === "character") skillProfile.characterId = integer(profile.characterId, "Character ID", 1, 2_147_483_647);
  const damage = object(input.damageProfile ?? UNIFORM, "Damage profile");
  const damageProfile = { ...UNIFORM };
  let damageSum = 0;
  for (const key of Object.keys(UNIFORM) as Array<keyof typeof UNIFORM>) {
    const amount = damage[key];
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1_000_000) invalid("Damage profile is invalid");
    damageProfile[key] = amount; damageSum += amount;
  }
  if (damageSum === 0) invalid("Damage profile must contain incoming damage");
  for (const key of Object.keys(UNIFORM) as Array<keyof typeof UNIFORM>) damageProfile[key] /= damageSum;
  const fit: CanonicalFit = { schemaVersion: 2, shipTypeId: ship.id, name: name.trim() || ship.name.en,
    slots, drones, cargo, implants, boosters, skillProfile, damageProfile };
  if (input.modeTypeId !== undefined) {
    const mode = itemType(input.modeTypeId, "Ship mode");
    // A mode is a specialised effect-bearing type, never a normal fitted item.
    if (mode.groupId !== 1306 || !mode.name.en.startsWith(`${ship.name.en} `)) invalid("Invalid ship mode for this hull");
    fit.modeTypeId = mode.id;
  } else {
    const modes = getFittingData().types.filter((mode) => mode.groupId === 1306 && mode.name.en.startsWith(`${ship.name.en} `));
    const initialMode = modes.find((mode) => /Defense Mode$|Primary Mode$/.test(mode.name.en)) ?? modes[0];
    if (initialMode) fit.modeTypeId = initialMode.id;
  }
  return fit;
}

/** Additive compatibility with the old shipId + quantity-list request. */
export function resolveWorkbenchFit(value: unknown): CanonicalFit {
  const input = object(value, "Fitting request");
  if (input.fit !== undefined) return validateCanonicalFit(input.fit);
  if (input.schemaVersion !== undefined) return validateCanonicalFit(input);
  const ship = itemType(input.shipId, "Ship");
  const slots: CanonicalFit["slots"] = []; const drones: CanonicalFit["drones"] = []; const cargo: CanonicalFit["cargo"] = [];
  const indexes: Record<string, number> = {};
  for (const entry of list(input.modules, "Modules")) {
    const module = object(entry, "Module"); const type = itemType(module.typeId, "Module");
    const quantity = integer(module.quantity ?? 1, "Quantity", 1, 99);
    if (categoryOf(type) === "drone" || categoryOf(type) === "fighter") drones.push({ typeId: type.id, quantity, activeQuantity: quantity });
    else if (RACKS.has(type.slot)) for (let i = 0; i < quantity; i++) {
      const index = indexes[type.slot] ?? 0; indexes[type.slot] = index + 1;
      slots.push({ rack: type.slot as WorkbenchRack, index, typeId: type.id, state: "active" });
    }
    else cargo.push({ typeId: type.id, quantity });
  }
  return validateCanonicalFit({ schemaVersion: 2, shipTypeId: ship.id, name: ship.name.en,
    slots, drones, cargo, skillProfile: { mode: "all5" }, damageProfile: UNIFORM });
}

function toEngineState(state: WorkbenchState): State { return state === "overheated" ? "overload" : state; }
function fromEngineState(state: State): WorkbenchState { return state === "overload" ? "overheated" : state; }
function toEngineFit(fit: CanonicalFit, skills?: Record<number, number>): Fit {
  let skillLevels: Record<number, number> = {};
  if (fit.skillProfile.mode === "all5") skillLevels = Object.fromEntries(getFittingData().types.filter((type) => type.categoryId === 16).map((type) => [type.id, 5]));
  else if (fit.skillProfile.mode === "character") {
    if (!skills) throw new FittingInputError("SKILLS_REQUIRED", "Character skills are required", 409);
    if (Object.keys(skills).length > 2000) invalid("Too many skills");
    for (const [id, level] of Object.entries(skills)) {
      const type = getFittingType(Number(id));
      if (!type || type.categoryId !== 16) continue; // New/removed ESI skills have no effect in this pinned SDE.
      skillLevels[type.id] = integer(level, "Skill level", 0, 5);
    }
  }
  const items: FitItem[] = fit.slots.map((slot) => ({ type_id: slot.typeId,
    slot: { type: slot.rack, index: slot.index }, state: toEngineState(slot.state),
    ...(slot.chargeTypeId ? { charge: { type_id: slot.chargeTypeId } } : {}) }));
  for (const [index, drone] of fit.drones.entries()) {
    const fighter = categoryOf(getFittingType(drone.typeId)!) === "fighter";
    if (drone.activeQuantity > 0) items.push({ type_id: drone.typeId, slot: fighter ? { type: "fighter_tube", index } : { type: "drone_bay" }, quantity: drone.activeQuantity, state: "active" });
    // EVEShipFit treats every non-offline drone-bay item as launched. Carried
    // drones stay offline; their passive bay-volume cost still applies.
    if (drone.quantity > drone.activeQuantity) items.push({ type_id: drone.typeId, slot: fighter ? { type: "fighter_bay" } : { type: "drone_bay" }, quantity: drone.quantity - drone.activeQuantity, state: "offline" });
  }
  for (const cargo of fit.cargo) items.push({ type_id: cargo.typeId, quantity: cargo.quantity, slot: { type: "cargo" }, state: "offline" });
  for (const implant of fit.implants ?? []) items.push({ type_id: implant.typeId, slot: { type: "implant", index: getFittingType(implant.typeId)!.attributes.implantness ?? 1 }, state: "active" });
  for (const booster of fit.boosters ?? []) items.push({ type_id: booster.typeId, slot: { type: "booster", index: getFittingType(booster.typeId)!.attributes.boosterness ?? 1 }, state: "active" });
  return { name: fit.name, ship: { type_id: fit.shipTypeId, ...(fit.modeTypeId ? { mode: fit.modeTypeId } : {}) }, items,
    character: { skills: skillLevels }, environment: { damage_profile: fit.damageProfile, reactive_armor: "do_not_adapt", security: "null_sec" } };
}

type JobAction = "calculate" | "loadEft" | "saveEft";
type Pending = { id: number; action: JobAction; fit?: Fit; text?: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> };
let worker: Worker | null = null; let active: Pending | null = null; let nextId = 0;
const queue: Pending[] = [];
function workerPath(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(dir, "fitting-engine-worker.mjs"), path.join(dir, "fitting-engine-worker.js")];
  const found = candidates.find(existsSync);
  if (!found) throw new FittingInputError("ENGINE_UNAVAILABLE", "Fitting engine worker was not built", 503);
  return found;
}
function ensureWorker(): Worker {
  if (worker) return worker;
  const engineEntry = require.resolve("@eveshipfit/dogma-engine");
  const dataDir = path.join(path.dirname(require.resolve("@eveshipfit/sde/package.json")), "dist");
  const instance = new Worker(workerPath(), { workerData: {
    engineEntry, wasmPath: path.join(path.dirname(engineEntry), "esf_dogma_engine_bg.wasm"),
    sdePath: path.join(dataDir, "sde.dat"), namesPath: path.join(dataDir, "names.dat"), expectedBuild: getFittingData().buildNumber,
  }, resourceLimits: { maxOldGenerationSizeMb: 128 } });
  worker = instance; instance.unref();
  instance.on("message", (message: { id: number; result?: unknown; error?: string }) => {
    if (worker !== instance || !active || message.id !== active.id) return;
    const job = active; active = null; clearTimeout(job.timer);
    if (message.error) job.reject(new FittingInputError("SIMULATION_FAILED", message.error.slice(0, 300), 422));
    else job.resolve(message.result);
    instance.unref(); dispatch();
  });
  instance.on("error", (error: Error) => failWorker(instance, new FittingInputError("SIMULATION_FAILED", "Fitting engine failed: " + error.message.slice(0, 160), 503)));
  instance.on("exit", () => { if (worker === instance) failWorker(instance, new FittingInputError("ENGINE_UNAVAILABLE", "Fitting engine restarted", 503)); });
  return instance;
}
function failWorker(instance: Worker, error: Error): void {
  if (worker !== instance) return;
  worker = null;
  if (active) { clearTimeout(active.timer); active.reject(error); active = null; }
  void instance.terminate(); dispatch();
}
function dispatch(): void {
  if (active || queue.length === 0) return;
  const job = queue.shift()!; active = job;
  try {
    const instance = ensureWorker(); instance.ref();
    job.timer = setTimeout(() => failWorker(instance, new FittingInputError("SIMULATION_TIMEOUT", "Fitting calculation timed out; simplify the fit and try again", 503)), 5000);
    instance.postMessage({ id: job.id, action: job.action, fit: job.fit, text: job.text });
  } catch (error) { active = null; job.reject(error instanceof Error ? error : new Error("Fitting engine unavailable")); dispatch(); }
}
function runWorker<T>(action: JobAction, payload: { fit?: Fit; text?: string }): Promise<T> {
  if (queue.length + (active ? 1 : 0) >= MAX_QUEUE) return Promise.reject(new FittingInputError("SIMULATION_BUSY", "Fitting engine is busy; try again shortly", 503));
  return new Promise<T>((resolve, reject) => { queue.push({ id: ++nextId, action, ...payload, resolve: (value) => resolve(value as T), reject }); dispatch(); });
}
/** Used by tests and orderly shutdown; the next request creates a fresh worker. */
export async function closeFittingEngine(): Promise<void> {
  const current = worker; worker = null;
  if (active) { clearTimeout(active.timer); active.reject(new FittingInputError("ENGINE_UNAVAILABLE", "Fitting engine stopped", 503)); active = null; }
  for (const job of queue.splice(0)) job.reject(new FittingInputError("ENGINE_UNAVAILABLE", "Fitting engine stopped", 503));
  if (current) await current.terminate();
}

const PATCHED: Record<string, number> = { alignTime: -1, capacitorPeakRecharge: -2, cycleTime: -3, capacitorPeakLoad: -4,
  capacitorPeakDelta: -5, capacitorDepletesIn: -7, damageAlpha: -11, damagePerSecondWithoutReload: -12,
  damagePerSecondWithReload: -13, droneDamagePerSecond: -14, damageVolley: -21, droneActive: -22, droneUsage: -23, droneCapacityLoad: -24,
  armorEhp: -28, hullEhp: -29, shieldEhp: -30, ehp: -43, armorRepairRate: -45, hullRepairRate: -46,
  shieldBoostRate: -47, armorEffectiveRepairRate: -48, hullEffectiveRepairRate: -49, shieldEffectiveBoostRate: -50,
  passiveShieldRechargeRate: -51, scanStrength: -53, fighterDamagePerSecond: -58, maxTargets: -70, capacitorStablePercentage: -72 };
function attribute(item: ItemResult | undefined, name: string, fallback = 0): number {
  const id = PATCHED[name] ?? getFittingData().attributeIds[name];
  const value = id === undefined ? undefined : item?.attributes.get(id)?.value;
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function clean(value: number): number { return Number.isFinite(value) ? Math.round(value * 1_000_000) / 1_000_000 : 0; }
function metric(used: number, limit: number): WorkbenchMetric { return { used: clean(used), limit: clean(limit), overloaded: used > limit + 1e-6 }; }
function resource(used: number, limit: number): WorkbenchResource { return { ...metric(used, limit), percent: limit > 0 ? clean(used / limit * 100) : (used > 0 ? 100 : 0) }; }
function violationMessage(violation: WorkbenchViolation, language: FittingLanguage): string {
  const r = violation.rule; const zh = language === "zh";
  if (r.type === "slot_index") return zh ? `${r.rack} 第 ${Number(r.index) + 1} 个槽位不存在（当前 ${r.available} 个槽位）` : `${r.rack} slot ${Number(r.index) + 1} does not exist (${r.available} slots available)`;
  if (r.type === "resource" || r.type === "slots") return zh ? `${String(r.resource ?? r.slot)} 超出上限：${r.used} / ${r.available}` : `${r.resource ?? r.slot} exceeds limit: ${r.used} / ${r.available}`;
  if (r.type === "skill") { const type = getFittingType(Number(r.type_id)); return zh ? `缺少技能：${type?.name.zh ?? r.type_id} ${r.required} 级（当前 ${r.level}）` : `Skill required: ${type?.name.en ?? r.type_id} ${r.required} (current ${r.level})`; }
  const names: Record<string, [string, string]> = { wrong_slot: ["装备不适合该槽位", "Module belongs in another rack"], slot_taken: ["槽位已被占用", "Slot is occupied"], rig_size: ["改装件尺寸不匹配", "Rig size does not match"], ship_restricted: ["装备不适用于该舰船", "Module cannot be fitted to this ship"], capital_item: ["旗舰装备不适用于该舰船", "Capital module cannot be fitted here"], charge_group: ["弹药类别不兼容", "Charge group is incompatible"], charge_size: ["弹药尺寸不匹配", "Charge size does not match"], max_group: ["同组装备超过可装配或激活上限", "Module group limit exceeded"], max_type: ["同型装备超过装配上限", "Module type limit exceeded"], subsystem_taken: ["同类子系统重复", "Subsystem already fitted"], wrong_slot_index: ["植入体或增效剂槽位不匹配", "Implant or booster slot does not match"] };
  return names[r.type]?.[zh ? 0 : 1] ?? (zh ? `装配限制：${r.type}` : `Fitting restriction: ${r.type}`);
}
export async function simulateWorkbench(value: CanonicalFit, language: FittingLanguage, skills?: Record<number, number>): Promise<WorkbenchSimulation> {
  const fit = validateCanonicalFit(value); const engineFit = toEngineFit(fit, skills);
  const result = await runWorker<Calculation>("calculate", { fit: engineFit });
  const compatibility = applySubsystemLayoutCompatibility(fit, result); const ship = result.ship;
  const a = (name: string, fallback = 0) => attribute(ship, name, fallback);
  const layer = (kind: "shield" | "armor" | "hull") => {
    const prefix = kind === "hull" ? "" : kind;
    const resistance = (damage: string) => clean(Math.max(0, Math.min(1, 1 - a(prefix + (prefix ? damage[0].toUpperCase() + damage.slice(1) : damage) + "DamageResonance", 1))));
    return { hp: clean(a(kind === "shield" ? "shieldCapacity" : kind === "armor" ? "armorHP" : "hp")), ehp: clean(a(kind + "Ehp")),
      resistances: { em: resistance("em"), thermal: resistance("thermal"), kinetic: resistance("kinetic"), explosive: resistance("explosive") } };
  };
  const shield = layer("shield"); const armor = layer("armor"); const hull = layer("hull");
  const limitNames = { high: "hiSlots", medium: "medSlots", low: "lowSlots", rig: "rigSlots", subsystem: "maxSubSystems", service: "serviceSlots" } as const;
  const slots = Object.fromEntries(Object.entries(limitNames).map(([rack, name]) => [rack, metric(fit.slots.filter((slot) => slot.rack === rack).length, a(name))])) as WorkbenchSimulation["slots"];
  const resources = { cpu: resource(a("cpuLoad"), a("cpuOutput")), powergrid: resource(a("powerLoad"), a("powerOutput")), calibration: resource(a("upgradeLoad"), a("upgradeCapacity")) };
  const moduleStates = fit.slots.map((slot, index) => ({ rack: slot.rack, index: slot.index, typeId: slot.typeId, requestedState: slot.state,
    state: compatibility.passiveSubsystemIndexes.has(index) ? "online" as const : fromEngineState(result.items[index]!.state),
    maxState: compatibility.passiveSubsystemIndexes.has(index) ? "online" as const : fromEngineState(result.items[index]!.max_state) }));
  const modules = fit.slots.map((slot, index) => ({ ...getFittingCatalogItem(slot.typeId, language)!, quantity: 1,
    cpu: clean(result.items[index]!.state === "offline" ? 0 : attribute(result.items[index], "cpu")),
    powergrid: clean(result.items[index]!.state === "offline" ? 0 : attribute(result.items[index], "power")), rack: slot.rack, index: slot.index, state: moduleStates[index]!.state,
    ...(slot.chargeTypeId ? { chargeTypeId: slot.chargeTypeId } : {}) }));
  const violations = [...(result.violations ?? []), ...compatibility.additionalViolations].map((v) => { const violation: WorkbenchViolation = { target: v.target, rule: v.rule as unknown as WorkbenchViolation["rule"], message: "" }; violation.message = violationMessage(violation, language); return violation; });
  const turretCount = fit.slots.filter((slot) => getFittingType(slot.typeId)?.hardpoint === "turret").length;
  const launcherCount = fit.slots.filter((slot) => getFittingType(slot.typeId)?.hardpoint === "launcher").length;
  const dps = a("damagePerSecondWithoutReload"); const droneDps = a("droneDamagePerSecond"); const fighterDps = a("fighterDamagePerSecond");
  // The patched ship DPS aggregates weapon, drone and fighter damage. Preserve
  // that aggregate rather than adding active-drone damage a second time.
  const totalDps = dps;
  const depletion = a("capacitorDepletesIn", -1); const stable = depletion < 0;
  const weapons = fit.slots.map((slot, index) => { const item = result.items[index]; const type = getFittingType(slot.typeId)!;
    return { typeId: slot.typeId, rack: slot.rack, index: slot.index, dps: clean(attribute(item, "damagePerSecondWithoutReload")), alpha: clean(attribute(item, "damageVolley")),
      cycleSeconds: clean(attribute(item, "cycleTime") / 1000), optimal: clean(attribute(item, "maxRange")), falloff: clean(attribute(item, "falloff")), tracking: clean(attribute(item, "trackingSpeed")),
      missileRange: type.hardpoint === "launcher" ? clean(attribute(item?.charge, "maxVelocity") * attribute(item?.charge, "explosionDelay") / 1000) : 0 };
  }).filter((weapon) => weapon.dps > 0 || weapon.alpha > 0);
  const stats: WorkbenchSimulation["stats"] = {
    cargo: { used: clean(fit.cargo.reduce((sum, item) => sum + (getFittingType(item.typeId)?.volume ?? 0) * item.quantity, 0)), capacity: clean(a("capacity", getFittingType(fit.shipTypeId)!.capacity ?? 0)) },
    defense: { shield, armor, hull, ehp: clean(a("ehp")) },
    offense: { dps: clean(totalDps), sustainedDps: clean(a("damagePerSecondWithReload")), alpha: clean(a("damageAlpha")), weaponDps: clean(Math.max(0, totalDps - droneDps - fighterDps)), droneDps: clean(droneDps), fighterDps: clean(fighterDps), weapons },
    capacitor: { capacity: clean(a("capacitorCapacity")), rechargeSeconds: clean(a("rechargeRate") / 1000), peakRecharge: clean(a("capacitorPeakRecharge")), usage: clean(a("capacitorPeakLoad")), delta: clean(a("capacitorPeakDelta")), stable, stablePercent: clean(stable ? a("capacitorStablePercentage") : 0), secondsToEmpty: stable ? null : clean(depletion) },
    navigation: { speed: clean(a("maxVelocity")), mass: clean(a("mass", getFittingType(fit.shipTypeId)!.mass ?? 0)), agility: clean(a("agility")), alignSeconds: clean(a("alignTime")), warpSpeed: clean(a("warpSpeedMultiplier")) },
    targeting: { range: clean(a("maxTargetRange")), maxTargets: clean(a("maxTargets", a("maxLockedTargets"))), scanResolution: clean(a("scanResolution")), signatureRadius: clean(a("signatureRadius")), sensorStrength: clean(a("scanStrength")) },
    drones: { bayUsed: clean(a("droneCapacityLoad")), bayCapacity: clean(a("droneCapacity")), bandwidthUsed: clean(a("droneBandwidthLoad")), bandwidthCapacity: clean(a("droneBandwidth")), active: clean(a("droneActive")), activeLimit: clean(attribute(result.character, "maxActiveDrones")), controlRange: clean(attribute(result.character, "droneControlDistance", a("droneControlDistance"))) },
    repair: { shield: clean(a("shieldBoostRate")), armor: clean(a("armorRepairRate")), hull: clean(a("hullRepairRate")), passiveShield: clean(a("passiveShieldRechargeRate")), shieldEffective: clean(a("shieldEffectiveBoostRate")), armorEffective: clean(a("armorEffectiveRepairRate")), hullEffective: clean(a("hullEffectiveRepairRate")) },
  };
  return { precision: "approximate", calculationPrecision: "dogma", sdeBuildNumber: getFittingData().buildNumber!, fit,
    engine: { name: "EVEShipFit Dogma Engine", version: "13.1.0", sdeReleaseDate: getFittingData().releaseDate,
      note: (language === "zh" ? "按当前所选技能、弹药和装备状态及固定静态数据版本计算；未逐项与游戏客户端对照，理论伤害不等于实战伤害。" : "Calculated from selected skills, ammunition and module states against the pinned SDE; not individually cross-checked against the game client, and theoretical damage is not applied combat damage.")
        + (compatibility.corrections.length ? language === "zh" ? " T3 子系统槽位及硬点使用固定 SDE 的定向兼容补正，其他属性与限制仍由 Dogma 计算。" : " T3 subsystem slots and hardpoints use a targeted pinned-SDE compatibility correction; other attributes and restrictions remain Dogma-calculated." : ""),
      ...(compatibility.corrections.length ? { compatibilityCorrections: compatibility.corrections } : {}) },
    ship: getFittingCatalogItem(fit.shipTypeId, language)!, modules, slots, resources,
    hardpoints: { turret: metric(turretCount, a("turretSlotsLeft")), launcher: metric(launcherCount, a("launcherSlotsLeft")) },
    defense: { shieldHp: shield.hp, armorHp: armor.hp, hullHp: hull.hp, estimatedEhp: stats.defense.ehp },
    mobility: { maxVelocity: stats.navigation.speed, mass: stats.navigation.mass, signatureRadius: stats.targeting.signatureRadius },
    capacitor: { capacity: stats.capacitor.capacity, rechargeTime: clean(a("rechargeRate")), activeCapUsePerSecond: stats.capacitor.usage },
    offense: { weaponCount: weapons.length + fit.drones.reduce((sum, drone) => sum + drone.activeQuantity, 0), estimatedDps: stats.offense.dps },
    recommendations: [], limitations: violations.map((v) => v.message), moduleStates, violations, valid: violations.length === 0, stats };
}

export async function parseEft(text: string, language: FittingLanguage = "zh"): Promise<WorkbenchEftResult> {
  if (typeof text !== "string" || text.length > 100_000 || text.split(/\r?\n/).length > 512) invalid("EFT text is too large");
  const engineFit = await runWorker<Fit>("loadEft", { text });
  const slots: CanonicalFit["slots"] = []; const drones = new Map<number, CanonicalFit["drones"][number]>(); const cargo: CanonicalFit["cargo"] = [];
  const implants: NonNullable<CanonicalFit["implants"]> = []; const boosters: NonNullable<CanonicalFit["boosters"]> = [];
  for (const item of engineFit.items) {
    if (RACKS.has(item.slot.type) && "index" in item.slot) slots.push({ rack: item.slot.type as WorkbenchRack, index: item.slot.index, typeId: item.type_id, state: fromEngineState(item.state), ...(item.charge ? { chargeTypeId: item.charge.type_id } : {}) });
    else if (["drone_bay", "fighter_bay", "fighter_tube"].includes(item.slot.type)) {
      const drone = drones.get(item.type_id) ?? { typeId: item.type_id, quantity: 0, activeQuantity: 0 };
      drone.quantity += item.quantity ?? 1; if (item.state === "active" || item.state === "overload") drone.activeQuantity += item.quantity ?? 1;
      drones.set(item.type_id, drone);
    } else if (item.slot.type === "implant") implants.push({ typeId: item.type_id });
    else if (item.slot.type === "booster") boosters.push({ typeId: item.type_id });
    else cargo.push({ typeId: item.type_id, quantity: item.quantity ?? 1 });
  }
  const fit = validateCanonicalFit({ schemaVersion: 2, shipTypeId: engineFit.ship.type_id, name: engineFit.name ?? "Imported fit", slots, drones: [...drones.values()], cargo, implants, boosters,
    skillProfile: { mode: "all5" }, damageProfile: UNIFORM, ...(engineFit.ship.mode ? { modeTypeId: engineFit.ship.mode } : {}) });
  return { fit, warnings: [language === "zh" ? "EFT 不保存技能、来袭伤害、激活与过热设置。导入后请检查装备状态及无人机出战数量。" : "EFT does not preserve skill, incoming-damage, activation or heat settings. Check module states and launched drones after importing."] };
}
export async function exportEft(value: CanonicalFit): Promise<WorkbenchExportResult> {
  const fit = validateCanonicalFit(value); const engineFit = toEngineFit({ ...fit, skillProfile: { mode: "none" } });
  return { text: await runWorker<string>("saveEft", { fit: engineFit }), warnings: ["EFT does not preserve all activation, heat, skill and incoming-damage settings."] };
}
