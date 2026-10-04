import type { CanonicalFit, WorkbenchRack } from "./fitting-engine-types";
import type { FittingLanguage } from "./fitting-data";
import type { FittingSimulationWithSource } from "./fitting-workbench-service";

export type FittingAdviceMode = "optimize" | "new";
export interface FittingAdviceRequest {
  fit: CanonicalFit;
  mode: FittingAdviceMode;
  goal: string;
  budgetIsk?: number;
  language: FittingLanguage;
}
/** Indicative whole-fit cost including retained implants and boosters.
 * Missing quotes are unknown, never zero; charge quantities are finite. */
export interface FittingAdvicePrice {
  estimatedTotalIsk: number | null;
  complete: boolean;
  basis: "jita_sell";
  checkedAt: string;
  missingTypeIds: number[];
  note: string;
}
export interface FittingAdviceChangeItem {
  typeId: number;
  name: string;
  quantity: number;
  chargeTypeId: number | null;
  chargeQuantity: number | null;
  chargeName: string | null;
  state: string | null;
  activeQuantity: number | null;
}
export interface FittingAdviceChange {
  section: "slot" | "drone" | "cargo";
  rack: WorkbenchRack | null;
  index: number | null;
  before: FittingAdviceChangeItem | null;
  after: FittingAdviceChangeItem | null;
}
export interface FittingAdviceSuggestion {
  id: string;
  title: string;
  rationale: string;
  tradeoffs: string[];
  fit: CanonicalFit;
  simulation: FittingSimulationWithSource;
  dogmaVerified: true;
  changes: FittingAdviceChange[];
  delta: { dps: number; sustainedDps: number; ehp: number; speed: number; alignSeconds: number; cpuLoad: number; powergridLoad: number };
  price: FittingAdvicePrice;
  withinBudget: boolean | null;
  eft: string;
  eftWarnings: string[];
  warnings: string[];
}
export interface FittingAdviceResponse {
  source: "openai";
  mode: FittingAdviceMode;
  model: string;
  generatedAt: string;
  summary: string;
  skillSource: FittingSimulationWithSource["skillSource"];
  baselineSimulation: FittingSimulationWithSource;
  baselinePrice: FittingAdvicePrice;
  suggestions: FittingAdviceSuggestion[];
  rejectedSuggestions: number;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number } | null;
  warnings: string[];
}
