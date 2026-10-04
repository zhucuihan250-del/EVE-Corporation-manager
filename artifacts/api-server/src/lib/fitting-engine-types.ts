import type { FittingLanguage, FittingSlot, FittingCategory } from "./fitting-data";

export type WorkbenchRack = "high" | "medium" | "low" | "rig" | "subsystem" | "service";
export type WorkbenchState = "offline" | "online" | "active" | "overheated";
export interface CanonicalFit {
  schemaVersion: 2;
  shipTypeId: number;
  name: string;
  slots: Array<{ rack: WorkbenchRack; index: number; typeId: number; state: WorkbenchState; chargeTypeId?: number; chargeQuantity?: number }>;
  drones: Array<{ typeId: number; quantity: number; activeQuantity: number }>;
  cargo: Array<{ typeId: number; quantity: number }>;
  implants?: Array<{ typeId: number }>;
  boosters?: Array<{ typeId: number }>;
  skillProfile: { mode: "all5" | "none" | "character"; characterId?: number };
  damageProfile: { em: number; thermal: number; kinetic: number; explosive: number };
  modeTypeId?: number;
}
export interface WorkbenchCatalogItem {
  typeId: number; category: FittingCategory; groupId: number; slot: FittingSlot;
  hardpoint: "turret" | "launcher" | null;
  name: string; nameEn: string; nameZh: string; groupName: string; categoryName: string;
}
export interface WorkbenchViolation {
  target: { type: string; index?: number };
  rule: Record<string, unknown> & { type: string };
  message: string;
}
export interface WorkbenchMetric { used: number; limit: number; overloaded: boolean }
export interface WorkbenchResource extends WorkbenchMetric { percent: number }
export interface WorkbenchLayer {
  hp: number; ehp: number;
  resistances: { em: number; thermal: number; kinetic: number; explosive: number };
}
export interface WorkbenchCompatibilityCorrection {
  code: "t3_subsystem_layout";
  attribute: string;
  engineValue: number;
  correctedValue: number;
  sourceTypeIds: number[];
  sdeBuildNumber: number;
}
export interface WorkbenchSimulation {
  precision: "approximate";
  calculationPrecision: "dogma";
  sdeBuildNumber: number;
  fit: CanonicalFit;
  engine: { name: string; version: string; sdeReleaseDate: string | null; note: string; compatibilityCorrections?: WorkbenchCompatibilityCorrection[] };
  ship: WorkbenchCatalogItem;
  modules: Array<WorkbenchCatalogItem & { quantity: number; cpu: number; powergrid: number; rack?: WorkbenchRack; index?: number; state?: WorkbenchState; chargeTypeId?: number }>;
  slots: Record<"high" | "medium" | "low" | "rig" | "subsystem" | "service", WorkbenchMetric>;
  resources: { cpu: WorkbenchResource; powergrid: WorkbenchResource; calibration: WorkbenchResource };
  hardpoints: { turret: WorkbenchMetric; launcher: WorkbenchMetric };
  defense: { shieldHp: number; armorHp: number; hullHp: number; estimatedEhp: number };
  mobility: { maxVelocity: number; mass: number; signatureRadius: number };
  capacitor: { capacity: number; rechargeTime: number | null; activeCapUsePerSecond: number };
  offense: { weaponCount: number; estimatedDps: number | null };
  recommendations: string[];
  limitations: string[];
  moduleStates: Array<{ rack: WorkbenchRack; index: number; typeId: number; requestedState: WorkbenchState; state: WorkbenchState; maxState: WorkbenchState }>;
  violations: WorkbenchViolation[];
  valid: boolean;
  stats: {
    cargo: { used: number; capacity: number };
    defense: { shield: WorkbenchLayer; armor: WorkbenchLayer; hull: WorkbenchLayer; ehp: number };
    offense: { dps: number; sustainedDps: number; alpha: number; weaponDps: number; droneDps: number; fighterDps: number; weapons: Array<{ typeId: number; rack: WorkbenchRack; index: number; dps: number; alpha: number; cycleSeconds: number; optimal: number; falloff: number; tracking: number; missileRange: number }> };
    capacitor: { capacity: number; rechargeSeconds: number; peakRecharge: number; usage: number; delta: number; stable: boolean; stablePercent: number; secondsToEmpty: number | null };
    navigation: { speed: number; mass: number; agility: number; alignSeconds: number; warpSpeed: number };
    targeting: { range: number; maxTargets: number; scanResolution: number; signatureRadius: number; sensorStrength: number };
    drones: { bayUsed: number; bayCapacity: number; bandwidthUsed: number; bandwidthCapacity: number; active: number; activeLimit: number; controlRange: number };
    repair: { shield: number; armor: number; hull: number; passiveShield: number; shieldEffective: number; armorEffective: number; hullEffective: number };
  };
}
export interface WorkbenchEftResult { fit: CanonicalFit; warnings: string[] }
export interface WorkbenchExportResult { text: string; warnings: string[] }
export interface WorkbenchRequest { fit: CanonicalFit; language: FittingLanguage; skills?: Record<number, number> }
