import type { CanonicalFit, FittingAdviceRequest, FittingAdviceResponse } from "./fitting-workbench-types";
import { fitKey, parseLocalDraft } from "./fitting-workbench-presentation";

export const FITTING_ADVICE_TIMEOUT_MS = 90_000;

export function parseFittingAdviceBudget(value: string): number | undefined | null {
  const text = value.trim();
  if (!text) return undefined;
  if (!/^\d{1,14}(?:\.\d{1,2})?$/.test(text)) return null;
  const amount = Number(text);
  return Number.isFinite(amount) && amount >= 0 && amount <= 1e13 ? amount : null;
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, limit = 10000): value is string =>
  typeof value === "string" && value.length <= limit;
const texts = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 256 && value.every(item => text(item));
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const skillKey = (value: CanonicalFit["skillProfile"]) =>
  JSON.stringify([value.mode, value.mode === "character" ? value.characterId : null]);
const damageKey = (value: CanonicalFit["damageProfile"]) => {
  const values = [value.em, value.thermal, value.kinetic, value.explosive];
  const total = values.reduce((sum, amount) => sum + amount, 0);
  return JSON.stringify(values.map(amount => Math.round(amount / total * 1e8)));
};
const stableKey = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (object(value)) return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const comparableFitKey = (fit: CanonicalFit) => stableKey({
  ...fit,
  implants: fit.implants ?? [],
  boosters: fit.boosters ?? [],
  damageProfile: damageKey(fit.damageProfile),
});
function validPrice(value: unknown) {
  return object(value) && value.basis === "jita_sell" && typeof value.complete === "boolean"
    && (value.estimatedTotalIsk === null || (finite(value.estimatedTotalIsk) && value.estimatedTotalIsk >= 0))
    && (value.complete ? finite(value.estimatedTotalIsk) : value.estimatedTotalIsk === null) && text(value.checkedAt, 100)
    && text(value.note) && Array.isArray(value.missingTypeIds)
    && value.missingTypeIds.every(id => Number.isSafeInteger(id) && id > 0)
    && (!value.complete || value.missingTypeIds.length === 0);
}
function validSimulation(value: unknown, requireValid: boolean) {
  if (!object(value) || (requireValid && value.valid !== true) || !object(value.stats)
    || !object(value.resources) || !object(value.skillSource)) return false;
  for (const key of ["cpu", "powergrid", "calibration"]) {
    const metric = value.resources[key];
    if (!object(metric) || ![metric.used, metric.limit, metric.percent].every(finite)) return false;
  }
  const stats = value.stats;
  if (!object(stats.offense) || !object(stats.defense) || !object(stats.capacitor) || !object(stats.navigation)) return false;
  return [stats.offense.dps, stats.offense.sustainedDps, stats.defense.ehp,
    stats.navigation.speed, stats.navigation.alignSeconds, stats.capacitor.usage,
    stats.capacitor.stablePercent].every(finite)
    && typeof stats.capacitor.stable === "boolean"
    && (stats.capacitor.secondsToEmpty === null || finite(stats.capacitor.secondsToEmpty))
    && Array.isArray(value.modules) && value.modules.length <= 256
    && value.modules.every(item => object(item) && Number.isSafeInteger(item.typeId) && Number(item.typeId) > 0 && text(item.name, 1000))
    && Array.isArray(value.violations) && Array.isArray(value.limitations)
    && object(value.ship) && Number.isSafeInteger(value.ship.typeId) && Number(value.ship.typeId) > 0 && text(value.ship.name, 1000);
}

function matchingSkillSource(value: unknown, fit: CanonicalFit) {
  return object(value) && value.mode === fit.skillProfile.mode
    && (fit.skillProfile.mode !== "character" || value.characterId === fit.skillProfile.characterId)
    && (value.characterName === undefined || text(value.characterName, 1000))
    && (value.checkedAt === undefined || text(value.checkedAt, 100));
}

function validChangeItem(value: unknown) {
  return value === null || (object(value) && Number.isSafeInteger(value.typeId)
    && text(value.name) && finite(value.quantity) && value.quantity > 0
    && (value.chargeTypeId === null || Number.isSafeInteger(value.chargeTypeId))
    && (value.chargeName === null || text(value.chargeName))
    && (value.chargeQuantity === null || (Number.isSafeInteger(value.chargeQuantity) && Number(value.chargeQuantity) > 0))
    && (value.state === null || text(value.state, 100))
    && (value.activeQuantity === null || finite(value.activeQuantity)));
}

/** Fail closed before marking an unexpected response as verified. Actual type,
 * equipment compatibility and Dogma checks remain server responsibilities. */
export function validateFittingAdviceResponse(value: unknown, request: FittingAdviceRequest): value is FittingAdviceResponse {
  if (!object(value) || value.source !== "openai" || value.mode !== request.mode
    || !text(value.summary) || !text(value.model, 200) || !text(value.generatedAt, 100)
    || !texts(value.warnings) || !object(value.skillSource)
    || !matchingSkillSource(value.skillSource, request.fit)
    || !validSimulation(value.baselineSimulation, false) || !validPrice(value.baselinePrice)
    || !Number.isSafeInteger(value.rejectedSuggestions) || Number(value.rejectedSuggestions) < 0
    || !Array.isArray(value.suggestions) || value.suggestions.length < 1 || value.suggestions.length > 2) return false;
  if (!matchingSkillSource((value.baselineSimulation as Record<string, unknown>).skillSource, request.fit)) return false;
  if (value.usage !== null && (!object(value.usage)
    || ![value.usage.inputTokens, value.usage.outputTokens, value.usage.totalTokens].every(item => Number.isSafeInteger(item) && Number(item) >= 0))) return false;
  return value.suggestions.every(suggestion => {
    if (!object(suggestion) || suggestion.dogmaVerified !== true || !text(suggestion.id, 200)
      || !text(suggestion.title) || !text(suggestion.rationale) || !texts(suggestion.tradeoffs)
      || !texts(suggestion.warnings) || !texts(suggestion.eftWarnings) || !text(suggestion.eft, 65536)
      || !validSimulation(suggestion.simulation, true) || !validPrice(suggestion.price)
      || ![true, false, null].includes(suggestion.withinBudget as boolean | null)
      || !Array.isArray(suggestion.changes) || suggestion.changes.length > 256
      || !suggestion.changes.every(change => object(change) && ["slot", "drone", "cargo"].includes(String(change.section))
        && (change.rack === null || ["high", "medium", "low", "rig", "subsystem", "service"].includes(String(change.rack)))
        && (change.index === null || (Number.isSafeInteger(change.index) && Number(change.index) >= 0))
        && validChangeItem(change.before) && validChangeItem(change.after))
      || !object(suggestion.delta)
      || !["dps", "sustainedDps", "ehp", "speed", "alignSeconds", "cpuLoad", "powergridLoad"].every(key => finite((suggestion.delta as Record<string, unknown>)[key]))) return false;
    const fit = parseLocalDraft(JSON.stringify(suggestion.fit));
    const simulatedFit = parseLocalDraft(JSON.stringify((suggestion.simulation as Record<string, unknown>).fit));
    const price = suggestion.price as Record<string, unknown>;
    if (!matchingSkillSource((suggestion.simulation as Record<string, unknown>).skillSource, request.fit)
      || ((!price.complete || request.budgetIsk === undefined) && suggestion.withinBudget !== null)) return false;
    return fit !== null && simulatedFit !== null && fit.shipTypeId === request.fit.shipTypeId
      && simulatedFit.shipTypeId === fit.shipTypeId && skillKey(fit.skillProfile) === skillKey(request.fit.skillProfile)
      && skillKey(simulatedFit.skillProfile) === skillKey(request.fit.skillProfile)
      && damageKey(fit.damageProfile) === damageKey(request.fit.damageProfile)
      && damageKey(simulatedFit.damageProfile) === damageKey(fit.damageProfile)
      && comparableFitKey(fit) === comparableFitKey(simulatedFit)
      && fit.modeTypeId === request.fit.modeTypeId
      && stableKey(fit.implants ?? []) === stableKey(request.fit.implants ?? [])
      && stableKey(fit.boosters ?? []) === stableKey(request.fit.boosters ?? []);
  });
}

export interface FittingAdviceSnapshot {
  fit: CanonicalFit;
  contextKey: string;
  actorKey: string;
  language: "zh" | "en";
}

export function fittingAdviceContextKey(
  fit: CanonicalFit,
  actorKey: string,
  language: "zh" | "en",
) {
  return JSON.stringify([actorKey, language, fitKey(fit)]);
}

/** Requests own a deep snapshot; the advisor never mutates the workbench fit. */
export function snapshotFittingAdvice(
  fit: CanonicalFit,
  actorKey: string,
  language: "zh" | "en",
): FittingAdviceSnapshot {
  return {
    fit: JSON.parse(fitKey(fit)) as CanonicalFit,
    contextKey: fittingAdviceContextKey(fit, actorKey, language),
    actorKey,
    language,
  };
}

export type AdviceCancelReason =
  | "cancelled"
  | "closed"
  | "unmounted"
  | "stale"
  | "superseded"
  | "timeout";
export interface AdviceRequestTicket {
  snapshot: FittingAdviceSnapshot;
  controller: AbortController;
  reason?: AdviceCancelReason;
}

/** Both an abort and an identity check are needed: a mocked, cached or late
 * transport may resolve even after the AbortSignal has been cancelled. */
export function createAdviceRequestGate() {
  let current: AdviceRequestTicket | null = null;
  const cancel = (reason: AdviceCancelReason) => {
    if (!current) return;
    const ticket = current;
    current = null;
    ticket.reason = reason;
    ticket.controller.abort();
  };
  return {
    begin(snapshot: FittingAdviceSnapshot) {
      cancel("superseded");
      current = { snapshot, controller: new AbortController() };
      return current;
    },
    isCurrent(ticket: AdviceRequestTicket, contextKey: string) {
      return current === ticket && !ticket.controller.signal.aborted
        && ticket.snapshot.contextKey === contextKey;
    },
    cancel,
    cancelTicket(ticket: AdviceRequestTicket, reason: AdviceCancelReason) {
      if (current !== ticket) return false;
      cancel(reason);
      return true;
    },
    finish(ticket: AdviceRequestTicket) {
      if (current === ticket) current = null;
    },
  };
}

export function fittingAdviceErrorText(error: unknown, zh: boolean) {
  const fallback = zh
    ? "建议服务暂时不可用，请稍后重试。当前配装未改变。"
    : "Advice is temporarily unavailable. Try again later; your fitting is unchanged.";
  const messages: Record<string, [string, string]> = {
    FITTING_AI_NOT_CONFIGURED: ["配船 AI 尚未配置，请联系管理员。", "Fitting AI is not configured. Please contact an administrator."],
    FITTING_AI_RATE_LIMIT: ["建议请求过于频繁，请稍后再试。", "Too many advice requests. Please try again later."],
    FITTING_AI_BUSY: ["配船 AI 正忙，请稍后再试。", "Fitting AI is busy. Please try again later."],
    FITTING_AI_TIMEOUT: ["生成建议超时，请重试。当前配装未改变。", "Advice generation timed out. Retry; your fitting is unchanged."],
    FITTING_AI_INVALID_INPUT: ["请检查用途、预算和当前船体后再生成。", "Check your goal, budget and selected hull, then try again."],
    FITTING_AI_NO_VALID_SUGGESTIONS: ["未得到通过装配校验的建议，请调整用途或条件后重试。", "No suggestions passed fitting checks. Adjust your goal or constraints and retry."],
    FITTING_AI_INVALID_OUTPUT: ["建议内容未通过校验，请重新生成。", "Advice could not be verified. Please generate it again."],
    FITTING_AI_INCOMPLETE: ["AI 返回的建议不完整，请重试。", "AI returned incomplete advice. Please try again."],
    FITTING_AI_REFUSED: ["AI 未能提供此建议，请调整用途描述后重试。", "AI could not provide this advice. Rephrase your goal and retry."],
    FITTING_AI_UNAVAILABLE: ["配船 AI 暂时不可用，请稍后重试。", "Fitting AI is temporarily unavailable. Please try again later."],
    SKILL_AUTHORIZATION_REQUIRED: ["请使用所选角色重新登录 EVE 并授权读取技能，再生成建议。", "Sign in to EVE with the selected character and authorize skill access, then generate advice."],
    ESI_SKILLS_UNAVAILABLE: ["本人角色技能暂时无法读取，请稍后重试；不会改用全 V 技能。", "Your character skills are temporarily unavailable. Retry later; all V skills will not be substituted."],
  };
  const code = object(error) && typeof error.code === "string" ? error.code : undefined;
  if (code && messages[code]) return messages[code][zh ? 0 : 1];
  if (!(error instanceof Error) || error.message.length > 2000
    || /<\/?[a-z!][^>]*>/i.test(error.message)
    || /(?:Bearer\s+|api[_-]?key\s*[:=]|access[_-]?token\s*[:=])/i.test(error.message)) return fallback;
  return error.message.trim() || fallback;
}
