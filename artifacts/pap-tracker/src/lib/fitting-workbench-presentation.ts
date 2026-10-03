import type {
  CanonicalFit,
  WorkbenchRack,
  WorkbenchState,
} from "./fitting-workbench-types";

export const rackOrder: WorkbenchRack[] = [
  "high",
  "medium",
  "low",
  "rig",
  "subsystem",
  "service",
];
export const rackNames = {
  high: ["高槽", "High"],
  medium: ["中槽", "Mid"],
  low: ["低槽", "Low"],
  rig: ["改装件", "Rigs"],
  subsystem: ["子系统", "Subsystems"],
  service: ["服务槽", "Services"],
} as const;
export const stateNames = {
  offline: ["离线", "Offline"],
  online: ["在线", "Online"],
  active: ["启用", "Active"],
  overheated: ["过热", "Overheated"],
} as const;
export const stateSymbols = {
  offline: "○",
  online: "●",
  active: "▶",
  overheated: "♨",
} as const;
export const typeIcon = (typeId: number) =>
  `https://images.evetech.net/types/${typeId}/icon?size=64`;
export const numberLabel = (value: number | null | undefined, digits = 1) =>
  value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString(undefined, { maximumFractionDigits: digits });
export function durationLabel(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  const seconds = Math.max(0, Math.round(value));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function fitKey(fit: CanonicalFit) {
  return JSON.stringify(fit);
}
export function emptyFit(shipTypeId = 0, name = ""): CanonicalFit {
  return {
    schemaVersion: 2,
    shipTypeId,
    name,
    slots: [],
    drones: [],
    cargo: [],
    implants: [],
    boosters: [],
    skillProfile: { mode: "all5" },
    damageProfile: { em: 25, thermal: 25, kinetic: 25, explosive: 25 },
  };
}
export function nextModuleState(
  state: WorkbenchState,
  maxState: WorkbenchState = "overheated",
  reverse = false,
): WorkbenchState {
  const states: WorkbenchState[] = [
    "offline",
    "online",
    "active",
    "overheated",
  ];
  const allowed = states.slice(0, states.indexOf(maxState) + 1);
  const index = Math.max(0, allowed.indexOf(state));
  return allowed[
    (index + (reverse ? -1 : 1) + allowed.length) % allowed.length
  ];
}
export function slotKey(rack: WorkbenchRack, index: number) {
  return `${rack}:${index}`;
}
export function firstEmptySlot(
  fit: CanonicalFit,
  rack: WorkbenchRack,
  limit: number,
) {
  for (let index = 0; index < limit; index++)
    if (
      !fit.slots.some((entry) => entry.rack === rack && entry.index === index)
    )
      return index;
  return null;
}
export function parseLocalDraft(value: string | null): CanonicalFit | null {
  if (!value) return null;
  try {
    const fit = JSON.parse(value);
    const object = (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry);
    const integer = (entry: unknown, min: number, max = 2_147_483_647) =>
      typeof entry === "number" &&
      Number.isSafeInteger(entry) &&
      entry >= min &&
      entry <= max;
    const characters = (entries: unknown) =>
      entries === undefined ||
      (Array.isArray(entries) &&
        entries.every((entry) => object(entry) && integer(entry.typeId, 1)));
    if (
      !object(fit) ||
      fit?.schemaVersion !== 2 ||
      !integer(fit.shipTypeId, 1) ||
      typeof fit.name !== "string" ||
      fit.name.length > 100 ||
      /[\r\n\u0000]/u.test(fit.name) ||
      !Array.isArray(fit.slots) ||
      !Array.isArray(fit.drones) ||
      !Array.isArray(fit.cargo) ||
      !characters(fit.implants) ||
      !characters(fit.boosters) ||
      !object(fit.skillProfile) ||
      !object(fit.damageProfile)
    )
      return null;
    if (
      fit.slots.length +
        fit.drones.length * 2 +
        fit.cargo.length +
        (Array.isArray(fit.implants) ? fit.implants.length : 0) +
        (Array.isArray(fit.boosters) ? fit.boosters.length : 0) >
      256
    )
      return null;
    if (
      !fit.slots.every(
        (entry: unknown) =>
          object(entry) &&
          rackOrder.includes(entry.rack as WorkbenchRack) &&
          integer(entry.index, 0, 31) &&
          integer(entry.typeId, 1) &&
          typeof entry.state === "string" &&
          Object.hasOwn(stateNames, entry.state) &&
          (entry.chargeTypeId === undefined ||
            integer(entry.chargeTypeId, 1)) &&
          (entry.chargeQuantity === undefined ||
            (entry.chargeTypeId !== undefined &&
              integer(entry.chargeQuantity, 1, 1_000_000))),
      )
    )
      return null;
    if (
      !fit.drones.every(
        (entry) =>
          object(entry) &&
          integer(entry.typeId, 1) &&
          integer(entry.quantity, 1, 1000) &&
          integer(entry.activeQuantity, 0, entry.quantity as number),
      ) ||
      !fit.cargo.every(
        (entry) =>
          object(entry) &&
          integer(entry.typeId, 1) &&
          integer(entry.quantity, 1, 1_000_000),
      )
    )
      return null;
    if (
      !["all5", "none", "character"].includes(String(fit.skillProfile.mode)) ||
      (fit.skillProfile.mode === "character" &&
        !integer(fit.skillProfile.characterId, 1))
    )
      return null;
    const damage = [
      fit.damageProfile.em,
      fit.damageProfile.thermal,
      fit.damageProfile.kinetic,
      fit.damageProfile.explosive,
    ];
    if (
      !damage.every(
        (entry) =>
          typeof entry === "number" &&
          Number.isFinite(entry) &&
          entry >= 0 &&
          entry <= 1_000_000,
      ) ||
      (damage as number[]).reduce((sum, entry) => sum + entry, 0) === 0 ||
      (fit.modeTypeId !== undefined && !integer(fit.modeTypeId, 1))
    )
      return null;
    return fit as unknown as CanonicalFit;
  } catch {
    return null;
  }
}
