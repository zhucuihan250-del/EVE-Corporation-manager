import { createHash } from "node:crypto";
import { categoryOf, getFittingCatalogItem, getFittingData, getFittingType, type FittingLanguage, type FittingType } from "./fitting-data";
import type { CanonicalFit, WorkbenchSimulation } from "./fitting-engine-types";
import type { FittingSkillContext, FittingSimulationWithSource, FittingWorkbenchEngine } from "./fitting-workbench-service";
import { fittingObject, FittingWorkbenchError, type FittingActor } from "./fitting-workbench-errors";
import { adviceError, type FittingAdviceProvider } from "./fitting-advice-provider";
import type { FittingAdviceChange, FittingAdviceChangeItem, FittingAdvicePrice, FittingAdviceRequest, FittingAdviceResponse, FittingAdviceSuggestion } from "./fitting-advice-types";

const MAX_CANDIDATES = 180, MAX_FIT_ITEMS = 64;
const KNOWN_SKILL_ERRORS: Record<string, [number, string]> = {
  SKILL_AUTHORIZATION_REQUIRED: [409, "请使用该角色重新登录 EVE 并授权读取技能，无需解绑角色。"],
  ESI_SKILLS_UNAVAILABLE: [503, "EVE 技能数据暂时不可用，请稍后重试。"],
  FITTING_CHARACTER_NOT_FOUND: [404, "找不到本人绑定的有效军团角色。"],
};
function strictObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw adviceError("FITTING_AI_INVALID_OUTPUT");
  return value as Record<string, unknown>;
}
function description(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw adviceError("FITTING_AI_INVALID_OUTPUT");
  return value.trim();
}
function array(value: unknown, max: number): unknown[] {
  if (!Array.isArray(value) || value.length > max) throw adviceError("FITTING_AI_INVALID_OUTPUT");
  return value;
}
function id(value: unknown, whitelist: Set<number>): number {
  if (!Number.isSafeInteger(value) || !whitelist.has(Number(value))) throw adviceError("FITTING_AI_INVALID_OUTPUT");
  return Number(value);
}
function count(value: unknown, max: number, min = 1): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw adviceError("FITTING_AI_INVALID_OUTPUT");
  return Number(value);
}
function input(value: unknown, engine: Pick<FittingWorkbenchEngine, "validateCanonicalFit">): FittingAdviceRequest {
  try {
    const body = fittingObject(value);
    if (Object.keys(body).some(key => !["fit", "mode", "goal", "budgetIsk", "language"].includes(key))) throw new Error();
    if (body.mode !== "optimize" && body.mode !== "new") throw new Error();
    if (typeof body.goal !== "string" || !body.goal.trim() || body.goal.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(body.goal)) throw new Error();
    if (body.language !== undefined && body.language !== "en" && body.language !== "zh") throw new Error();
    if (body.budgetIsk !== undefined && (typeof body.budgetIsk !== "number" || !Number.isFinite(body.budgetIsk) || body.budgetIsk < 0 || body.budgetIsk > 1e13)) throw new Error();
    const fit = engine.validateCanonicalFit(body.fit);
    if (fit.slots.length + fit.drones.length + fit.cargo.length + (fit.implants?.length ?? 0) + (fit.boosters?.length ?? 0) > MAX_FIT_ITEMS) throw new Error();
    return { fit, mode: body.mode, goal: body.goal.trim(), language: body.language === "en" ? "en" : "zh", ...(body.budgetIsk === undefined ? {} : { budgetIsk: body.budgetIsk as number }) };
  } catch { throw adviceError("FITTING_AI_INVALID_INPUT"); }
}

/** A bounded, public SDE candidate universe, not arbitrary AI item names.
 * Current types are retained first; alternatives cover distinct equipment
 * groups. Final suitability, skills and resource loads remain Dogma's job. */
export function buildFittingAdviceCandidates(fit: CanonicalFit, baseline: WorkbenchSimulation): FittingType[] {
  const selected = new Set([...fit.slots.flatMap(slot => [slot.typeId, ...(slot.chargeTypeId ? [slot.chargeTypeId] : [])]), ...fit.drones.map(item => item.typeId), ...fit.cargo.map(item => item.typeId)]);
  const selectedGroups = new Set([...selected].map(typeId => getFittingType(typeId)?.groupId));
  const ship = getFittingType(fit.shipTypeId)!;
  const mass = ship.mass ?? 0, size = mass < 2_000_000 ? 1 : mass < 30_000_000 ? 2 : mass < 300_000_000 ? 3 : 4;
  // Mass is only a preference, never an equipment eligibility rule. Attack
  // battlecruisers use large turrets and bombers use torpedo launchers despite
  // cruiser/frigate mass, with role-specific CPU/PG reductions in Dogma.
  const preferredSize = (type: FittingType) => type.hardpoint === "turret" && ship.attributes.bcLargeTurretPower > 0 ? 3
    : type.hardpoint === "launcher" && ship.attributes.stealthBomberLauncherPower > 0 ? 3 : size;
  const sizeRank = (type: FittingType) => type.hardpoint && type.attributes.chargeSize ? Number(type.attributes.chargeSize !== preferredSize(type)) : 0;
  const resourceRank = (type: FittingType) => {
    const powerFactor = type.hardpoint === "turret" && type.attributes.chargeSize === 3 ? ship.attributes.bcLargeTurretPower ?? 1
      : type.hardpoint === "launcher" && type.attributes.chargeSize === 3 ? ship.attributes.stealthBomberLauncherPower ?? 1 : 1;
    const cpuFactor = type.hardpoint === "turret" && type.attributes.chargeSize === 3 ? ship.attributes.bcLargeTurretCPU ?? 1 : 1;
    return Math.max((type.attributes.power ?? 0) * powerFactor / Math.max(1, baseline.resources.powergrid.limit), (type.attributes.cpu ?? 0) * cpuFactor / Math.max(1, baseline.resources.cpu.limit));
  };
  const result: FittingType[] = [], included = new Set<number>();
  const add = (type: FittingType) => { if (type.published && !included.has(type.id) && result.length < MAX_CANDIDATES) { result.push(type); included.add(type.id); } };
  for (const typeId of selected) { const type = getFittingType(typeId); if (type) add(type); }
  // T3 subsystems have their own meta group. Retain every subsystem family for
  // this exact hull; another strategic cruiser's subsystem is never offered.
  for (const type of getFittingData().types) if (type.slot === "subsystem" && type.attributes.fitsToShipType === ship.id) add(type);
  const modules = getFittingData().types.filter(type => {
    if (!type.published || !["module", "subsystem"].includes(categoryOf(type))) return false;
    if (type.slot === "rig" && ship.attributes.rigSize && type.attributes.rigSize !== ship.attributes.rigSize) return false;
    if (type.slot === "service" && baseline.slots.service.limit === 0) return false;
    if (type.slot === "subsystem") return type.attributes.fitsToShipType === ship.id;
    return [1, 2].includes(type.metaGroupId ?? 1) || selectedGroups.has(type.groupId);
  }).sort((a, b) => Number(selectedGroups.has(b.groupId)) - Number(selectedGroups.has(a.groupId)) || sizeRank(a) - sizeRank(b) || (a.metaGroupId ?? 1) - (b.metaGroupId ?? 1) || resourceRank(a) - resourceRank(b) || a.id - b.id);
  const groups = new Map<number, FittingType[]>();
  for (const type of modules) { const group = groups.get(type.groupId) ?? []; group.push(type); groups.set(type.groupId, group); }
  // Role weapons get guaranteed space before the broad group round-robin.
  // Torpedo launchers do not expose chargeSize in this SDE; their torpedo
  // charge group (89) is the authoritative compatibility link instead.
  const roleWeaponGroups = new Map<number, FittingType[]>();
  for (const type of modules) if ((ship.attributes.bcLargeTurretPower > 0 && type.hardpoint === "turret" && type.attributes.chargeSize === 3)
    || (ship.attributes.stealthBomberLauncherPower > 0 && type.hardpoint === "launcher" && [1, 2, 3, 4, 5].some(index => type.attributes[`chargeGroup${index}`] === 89))) {
    const group = roleWeaponGroups.get(type.groupId) ?? []; group.push(type); roleWeaponGroups.set(type.groupId, group);
  }
  for (const group of roleWeaponGroups.values()) for (const metaGroup of [1, 2]) { const type = group.find(type => (type.metaGroupId ?? 1) === metaGroup); if (type) add(type); }
  // Round-robin prevents a large turret/rig group crowding out tank, utility,
  // propulsion and support groups. Room remains for compatible ammo/drones.
  for (let round = 0; round < 3 && result.length < 120; round++) for (const group of groups.values()) {
    const tiers = round === 1 ? group.filter(type => type.metaGroupId === 2) : group.filter(type => type.metaGroupId !== 2);
    const type = tiers[round === 2 ? 1 : 0]; if (type && result.length < 120) add(type);
  }
  const chargeGroups = new Map<number, Set<number>>();
  for (const module of result.filter(type => type.slot !== "charge")) for (let index = 1; index <= 5; index++) {
    const group = module.attributes[`chargeGroup${index}`]; if (!group) continue;
    const sizes = chargeGroups.get(group) ?? new Set<number>(); sizes.add(module.attributes.chargeSize ?? 0); chargeGroups.set(group, sizes);
  }
  const charges = getFittingData().types.filter(type => type.published && categoryOf(type) === "charge" && chargeGroups.has(type.groupId)
    && (!type.attributes.chargeSize || chargeGroups.get(type.groupId)!.has(0) || chargeGroups.get(type.groupId)!.has(type.attributes.chargeSize)));
  const chargeBuckets = new Map<string, FittingType[]>();
  for (const type of charges) { const key = `${type.groupId}:${type.attributes.chargeSize ?? 0}`, items = chargeBuckets.get(key) ?? []; items.push(type); chargeBuckets.set(key, items); }
  for (let round = 0; round < 6; round++) for (const items of chargeBuckets.values()) { const type = items[round]; if (type && result.length < 160) add(type); }
  const drones = getFittingData().types.filter(type => type.published && ["drone", "fighter"].includes(categoryOf(type)) && (type.volume ?? 0) <= baseline.stats.drones.bayCapacity && (type.attributes.droneBandwidthUsed ?? 0) <= baseline.stats.drones.bandwidthCapacity);
  for (const type of drones.filter(type => /^(Hobgoblin|Warrior|Acolyte|Hornet|Hammerhead|Valkyrie|Infiltrator|Vespa) (I|II)$/u.test(type.name.en))) add(type);
  for (let round = 0; round < 2; round++) {
    const droneGroups = new Map<number, FittingType[]>();
    for (const type of drones) { const group = droneGroups.get(type.groupId) ?? []; group.push(type); droneGroups.set(type.groupId, group); }
    for (const group of droneGroups.values()) if (group[round]) add(group[round]!);
  }
  return result;
}

function candidateData(type: FittingType, language: FittingLanguage) {
  const important = /^(cpu|power|capacity|chargeSize|chargeGroup\d|rigSize|damageMultiplier|speedFactor|duration|armorHP|shieldCapacity|maxRange|falloff|trackingSpeed|droneBandwidthUsed|requiredSkill\d(Level)?|fitsToShipType|subSystemSlot|bcLargeTurret(Power|CPU|Cap)|stealthBomberLauncherPower)$/u;
  return { typeId: type.id, name: type.name[language], category: categoryOf(type), slot: type.slot, group: type.groupName[language], metaGroupId: type.metaGroupId ?? null,
    hardpoint: type.hardpoint ?? null, capabilities: getFittingCatalogItem(type.id, language)?.capabilities,
    volume: type.volume ?? 0, capacity: type.capacity ?? 0, attributes: Object.fromEntries(Object.entries(type.attributes).filter(([key]) => important.test(key))) };
}
function proposal(value: unknown, seed: CanonicalFit, whitelist: Set<number>, engine: Pick<FittingWorkbenchEngine, "validateCanonicalFit">) {
  const item = strictObject(value, ["title", "rationale", "tradeoffs", "slots", "drones", "cargo"]);
  const title = description(item.title, 100), rationale = description(item.rationale, 1500), tradeoffs = array(item.tradeoffs, 6).map(value => description(value, 600));
  if (tradeoffs.length === 0) throw adviceError("FITTING_AI_INVALID_OUTPUT");
  const occupied = new Set<string>();
  const slots = array(item.slots, 64).map(value => {
    const slot = strictObject(value, ["rack", "index", "typeId", "state", "chargeTypeId", "chargeQuantity"]);
    const typeId = id(slot.typeId, whitelist), index = count(slot.index, 31, 0), key = `${slot.rack}:${index}`;
    if (occupied.has(key)) throw adviceError("FITTING_AI_INVALID_OUTPUT"); occupied.add(key);
    if (slot.chargeTypeId === undefined || slot.chargeQuantity === undefined) throw adviceError("FITTING_AI_INVALID_OUTPUT");
    if (slot.chargeTypeId === null && slot.chargeQuantity !== null) throw adviceError("FITTING_AI_INVALID_OUTPUT");
    return { rack: slot.rack, index, typeId, state: slot.state,
      ...(slot.chargeTypeId === null ? {} : { chargeTypeId: id(slot.chargeTypeId, whitelist), chargeQuantity: count(slot.chargeQuantity, 1_000_000) }) };
  });
  if (!slots.length || slots.every(slot => slot.state === "offline")) throw adviceError("FITTING_AI_INVALID_OUTPUT");
  const droneTypes = new Set<number>(), cargoTypes = new Set<number>();
  const drones = array(item.drones, 16).map(value => {
    const drone = strictObject(value, ["typeId", "quantity", "activeQuantity"]), typeId = id(drone.typeId, whitelist);
    if (droneTypes.has(typeId)) throw adviceError("FITTING_AI_INVALID_OUTPUT"); droneTypes.add(typeId);
    return { typeId, quantity: count(drone.quantity, 1000), activeQuantity: count(drone.activeQuantity, 1000, 0) };
  });
  const cargo = array(item.cargo, 16).map(value => {
    const item = strictObject(value, ["typeId", "quantity"]), typeId = id(item.typeId, whitelist);
    if (cargoTypes.has(typeId)) throw adviceError("FITTING_AI_INVALID_OUTPUT"); cargoTypes.add(typeId);
    return { typeId, quantity: count(item.quantity, 1_000_000) };
  });
  // Model cannot change hull, skills, incoming damage, mode, implants/boosters.
  const fit = engine.validateCanonicalFit({ ...seed, name: title, slots, drones, cargo });
  return { title, rationale, tradeoffs, fit };
}
function fittingIssues(result: WorkbenchSimulation): string[] {
  const issues = result.violations.map(item => item.message);
  if (!result.valid) issues.push("计算引擎未确认该配装有效。");
  if (Object.values(result.resources).some(item => item.overloaded) || Object.values(result.slots).some(item => item.overloaded) || Object.values(result.hardpoints).some(item => item.overloaded)) issues.push("配装超出资源或槽位上限。");
  const drones = result.stats.drones;
  if (drones.bayUsed > drones.bayCapacity || drones.bandwidthUsed > drones.bandwidthCapacity || drones.active > drones.activeLimit || result.stats.cargo.used > result.stats.cargo.capacity) issues.push("无人机或货舱超出容量。");
  if (result.moduleStates.some(item => item.state !== item.requestedState)) issues.push("装备不能达到请求的工作状态。");
  if (result.fit.slots.some(slot => slot.index >= result.slots[slot.rack].limit)) issues.push("装备位置超过实际槽位上限。");
  for (const slot of result.fit.slots) if (slot.chargeTypeId) {
    const capacity = getFittingCatalogItem(slot.typeId, "en")?.capabilities?.chargeCapacity ?? 0, volume = getFittingType(slot.chargeTypeId)?.volume ?? 0;
    // Quantity is a finite loaded stack, not cargo or unlimited resupply.
    // The tiny epsilon only avoids decimal-volume rounding at exact capacity.
    const maximum = capacity > 0 && volume > 0 ? Math.floor((capacity + volume * 1e-9) / volume) : 0;
    if ((slot.chargeQuantity ?? 1) > maximum) issues.push("装填弹药数量超过该装备弹仓容量，或容量无法核验。");
  }
  return issues;
}
const changedFitKey = (fit: CanonicalFit) => JSON.stringify({ slots: [...fit.slots].sort((a, b) => a.rack.localeCompare(b.rack) || a.index - b.index), drones: [...fit.drones].sort((a, b) => a.typeId - b.typeId), cargo: [...fit.cargo].sort((a, b) => a.typeId - b.typeId) });
function changeItem(typeId: number, quantity: number, language: FittingLanguage, extra: Partial<FittingAdviceChangeItem> = {}): FittingAdviceChangeItem {
  return { typeId, name: getFittingType(typeId)?.name[language] ?? String(typeId), quantity, chargeTypeId: null, chargeQuantity: null, chargeName: null, state: null, activeQuantity: null, ...extra };
}
export function fittingAdviceChanges(before: CanonicalFit, after: CanonicalFit, language: FittingLanguage): FittingAdviceChange[] {
  const changes: FittingAdviceChange[] = [];
  const slots = new Set([...before.slots, ...after.slots].map(slot => `${slot.rack}:${slot.index}`));
  for (const key of slots) {
    const a = before.slots.find(slot => `${slot.rack}:${slot.index}` === key), b = after.slots.find(slot => `${slot.rack}:${slot.index}` === key);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const shape = (slot: NonNullable<typeof a>) => changeItem(slot.typeId, 1, language, { state: slot.state, chargeTypeId: slot.chargeTypeId ?? null, chargeQuantity: slot.chargeTypeId ? slot.chargeQuantity ?? 1 : null, chargeName: slot.chargeTypeId ? getFittingType(slot.chargeTypeId)?.name[language] ?? null : null });
    changes.push({ section: "slot", rack: (a ?? b)!.rack, index: (a ?? b)!.index, before: a ? shape(a) : null, after: b ? shape(b) : null });
  }
  const aggregate = (items: Array<{ typeId: number; quantity: number; activeQuantity?: number }>) => {
    const result = new Map<number, { typeId: number; quantity: number; activeQuantity: number | null }>();
    for (const item of items) {
      const previous = result.get(item.typeId);
      result.set(item.typeId, { typeId: item.typeId, quantity: (previous?.quantity ?? 0) + item.quantity, activeQuantity: item.activeQuantity === undefined ? null : (previous?.activeQuantity ?? 0) + item.activeQuantity });
    }
    return result;
  };
  for (const section of ["drones", "cargo"] as const) for (const typeId of new Set([...before[section], ...after[section]].map(item => item.typeId))) {
    const a = aggregate(before[section]).get(typeId), b = aggregate(after[section]).get(typeId);
    if (JSON.stringify(a) === JSON.stringify(b)) continue;
    const shape = (item: NonNullable<typeof a>) => changeItem(item.typeId, item.quantity, language, { activeQuantity: item.activeQuantity });
    changes.push({ section: section === "drones" ? "drone" : "cargo", rack: null, index: null, before: a ? shape(a) : null, after: b ? shape(b) : null });
  }
  return changes;
}
function delta(before: WorkbenchSimulation, after: WorkbenchSimulation): FittingAdviceSuggestion["delta"] {
  const finite = (n: number) => Number.isFinite(n) ? Math.round(n * 10000) / 10000 : 0;
  return { dps: finite(after.stats.offense.dps - before.stats.offense.dps), sustainedDps: finite(after.stats.offense.sustainedDps - before.stats.offense.sustainedDps), ehp: finite(after.stats.defense.ehp - before.stats.defense.ehp), speed: finite(after.stats.navigation.speed - before.stats.navigation.speed), alignSeconds: finite(after.stats.navigation.alignSeconds - before.stats.navigation.alignSeconds), cpuLoad: finite(after.resources.cpu.used - before.resources.cpu.used), powergridLoad: finite(after.resources.powergrid.used - before.resources.powergrid.used) };
}

export function createFittingAdviceService(dependencies: {
  engine: Pick<FittingWorkbenchEngine, "validateCanonicalFit" | "simulateWorkbench" | "exportEft">;
  resolveSkills(actor: FittingActor, fit: CanonicalFit): Promise<FittingSkillContext>;
  provider: FittingAdviceProvider;
  quoteFits(fits: CanonicalFit[], options?: { signal?: AbortSignal }): Promise<FittingAdvicePrice[]>;
  now?: () => number;
  timeoutMs?: number;
  limits?: { perMinute?: number; globalConcurrent?: number; maxWindowKeys?: number };
}) {
  const now = dependencies.now ?? Date.now, windows = new Map<string, { start: number; count: number }>(), running = new Set<string>();
  let active = 0;
  async function advise(actor: FittingActor, value: unknown, outerSignal?: AbortSignal): Promise<FittingAdviceResponse> {
    const request = input(value, dependencies.engine);
    if (outerSignal?.aborted) throw adviceError("FITTING_AI_TIMEOUT");
    // No ESI or Dogma work when administrators have not configured the AI.
    if (!dependencies.provider.isConfigured()) throw adviceError("FITTING_AI_NOT_CONFIGURED");
    const key = `${actor.corporationId}:${actor.userId}`, currentTime = now();
    for (const [windowKey, entry] of windows) if (currentTime - entry.start >= 60_000) windows.delete(windowKey);
    const window = windows.get(key);
    if ((window?.count ?? 0) >= (dependencies.limits?.perMinute ?? 3) || (!window && windows.size >= (dependencies.limits?.maxWindowKeys ?? 5000))) throw adviceError("FITTING_AI_RATE_LIMIT");
    if (running.has(key) || active >= (dependencies.limits?.globalConcurrent ?? 2)) throw adviceError("FITTING_AI_BUSY");
    windows.set(key, { start: window?.start ?? currentTime, count: (window?.count ?? 0) + 1 });
    running.add(key); active++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    outerSignal?.addEventListener("abort", abort, { once: true });
    if (outerSignal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? 75_000);
    const checkActive = () => { if (controller.signal.aborted) throw adviceError("FITTING_AI_TIMEOUT"); };
    const bounded = async <T>(task: Promise<T>): Promise<T> => {
      if (controller.signal.aborted) { void task.catch(() => undefined); throw adviceError("FITTING_AI_TIMEOUT"); }
      let abort!: () => void;
      const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(adviceError("FITTING_AI_TIMEOUT")); controller.signal.addEventListener("abort", abort, { once: true }); });
      try { return await Promise.race([task, aborted]); } finally { controller.signal.removeEventListener("abort", abort); }
    };
    try {
      checkActive();
      const context = await bounded(dependencies.resolveSkills(actor, request.fit));
      const levels = context.levels ? Object.freeze({ ...context.levels }) : undefined;
      const simulate = async (fit: CanonicalFit): Promise<FittingSimulationWithSource> => { checkActive(); return { ...await bounded(dependencies.engine.simulateWorkbench(fit, request.language, levels)), skillSource: context.skillSource }; };
      const baseline = await simulate(request.fit), candidates = buildFittingAdviceCandidates(request.fit, baseline), whitelist = new Set(candidates.map(type => type.id));
      if (!candidates.length) throw adviceError("FITTING_AI_NO_VALID_SUGGESTIONS");
      const seed = request.mode === "new" ? { ...request.fit, slots: [], drones: [], cargo: [] } : request.fit;
      const publicSeed = { ...seed, name: "Selected hull", skillProfile: { mode: seed.skillProfile.mode } };
      const data = { seed: publicSeed, ship: candidateData(getFittingType(seed.shipTypeId)!, request.language), skillLevels: levels ?? null,
        baseline: { resources: baseline.resources, slots: baseline.slots, hardpoints: baseline.hardpoints, stats: baseline.stats }, candidates: candidates.map(type => candidateData(type, request.language)) };
      if (Buffer.byteLength(JSON.stringify(data), "utf8") > 96 * 1024) throw adviceError("FITTING_AI_INVALID_INPUT");
      checkActive();
      const result = await bounded(dependencies.provider.generate({ mode: request.mode, language: request.language, goal: request.goal, budgetIsk: request.budgetIsk ?? null, data, safetyIdentifier: createHash("sha256").update(key).digest("hex") }, controller.signal));
      const output = strictObject(result.output, ["summary", "suggestions"]), summary = description(output.summary, 2000), proposals = array(output.suggestions, 2);
      if (!proposals.length) throw adviceError("FITTING_AI_NO_VALID_SUGGESTIONS");
      const accepted: Array<{ suggestion: ReturnType<typeof proposal>; simulation: FittingSimulationWithSource }> = [];
      const seen = new Set<string>(); let rejected = 0;
      for (const raw of proposals) {
        try {
          const item = proposal(raw, seed, whitelist, dependencies.engine), signature = changedFitKey(item.fit);
          if (seen.has(signature) || signature === changedFitKey(request.fit)) { rejected++; continue; }
          seen.add(signature);
          const simulation = await simulate(item.fit);
          if (fittingIssues(simulation).length) { rejected++; continue; }
          accepted.push({ suggestion: item, simulation });
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error ? error.code : null;
          if (controller.signal.aborted || code === "FITTING_AI_TIMEOUT") throw adviceError("FITTING_AI_TIMEOUT");
          if (code === "SIMULATION_BUSY") throw adviceError("FITTING_AI_BUSY");
          if (code === "SIMULATION_TIMEOUT") throw adviceError("FITTING_AI_TIMEOUT");
          rejected++;
        }
      }
      if (!accepted.length) throw adviceError("FITTING_AI_NO_VALID_SUGGESTIONS");
      const fits = [request.fit, ...accepted.map(item => item.suggestion.fit)];
      const unknownPrice = (): FittingAdvicePrice => ({ estimatedTotalIsk: null, complete: false, basis: "jita_sell", checkedAt: new Date(now()).toISOString(), missingTypeIds: [], note: "行情暂不可用，预算无法核验；未将未知价格按零计算。" });
      let prices: FittingAdvicePrice[];
      checkActive();
      try { prices = await bounded(dependencies.quoteFits(fits, { signal: controller.signal })); }
      catch (error) { if (controller.signal.aborted) throw error; prices = fits.map(unknownPrice); }
      if (prices.length !== fits.length) prices = fits.map(unknownPrice);
      const warnings = ["只提供建议，不会应用或保存配装，不会操作游戏。", "Dogma 验证仅针对所选模拟条件；尚未逐项与游戏客户端对照，理论 DPS 不等于实战效果。", "估价包括配装中的植入体、增效剂和有限弹药数量；最低卖价不保证足量成交，持续输出按理论满弹仓循环计算。"];
      if (request.fit.skillProfile.mode !== "character") warnings.push("未使用本人实际技能；全 V／无技能模式不代表本人能驾驶或装配。");
      const suggestions: FittingAdviceSuggestion[] = [];
      for (let index = 0; index < accepted.length; index++) {
        checkActive();
        const item = accepted[index]!, price = prices[index + 1]!, eft = await bounded(dependencies.engine.exportEft(item.suggestion.fit));
        const withinBudget = request.budgetIsk === undefined || !price.complete || price.estimatedTotalIsk === null ? null : price.estimatedTotalIsk <= request.budgetIsk;
        suggestions.push({ id: `suggestion-${index + 1}`, title: item.suggestion.title, rationale: item.suggestion.rationale, tradeoffs: item.suggestion.tradeoffs, fit: item.suggestion.fit, simulation: item.simulation, dogmaVerified: true,
          changes: fittingAdviceChanges(request.fit, item.suggestion.fit, request.language), delta: delta(baseline, item.simulation), price, withinBudget, eft: eft.text, eftWarnings: eft.warnings,
          warnings: [...(!price.complete ? ["行情不完整，不能认定该方案符合预算。"] : []), ...(withinBudget === false ? ["该方案的估计总成本超过所设预算。"] : [])] });
      }
      return { source: "openai", mode: request.mode, model: result.model, generatedAt: new Date(now()).toISOString(), summary, skillSource: context.skillSource, baselineSimulation: baseline, baselinePrice: prices[0]!, suggestions, rejectedSuggestions: rejected, usage: result.usage, warnings };
    } catch (error) {
      if (controller.signal.aborted) throw adviceError("FITTING_AI_TIMEOUT");
      if (error instanceof FittingWorkbenchError && KNOWN_SKILL_ERRORS[error.code]) {
        const [status, message] = KNOWN_SKILL_ERRORS[error.code]!; throw new FittingWorkbenchError(status, error.code, message);
      }
      if (error instanceof FittingWorkbenchError && error.code.startsWith("FITTING_AI_")) throw adviceError(error.code);
      throw adviceError("FITTING_AI_UNAVAILABLE");
    } finally { clearTimeout(timer); outerSignal?.removeEventListener("abort", abort); controller.abort(); running.delete(key); active--; }
  }
  return { advise };
}
