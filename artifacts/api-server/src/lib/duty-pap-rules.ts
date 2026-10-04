import { formatPapUnits, MAX_PAP, parsePapDecimal } from "./pap-currency-math";

export const DUTY_PAP_SCOPES = [
  "esi-fleets.read_fleet.v1",
  "esi-location.read_online.v1",
  "esi-location.read_location.v1",
  "esi-location.read_ship_type.v1",
] as const;
export const DUTY_PAP_POLL_MS = 60_000;
export const DUTY_PAP_MAX_GAP_MS = 150_000;
export const DUTY_PAP_MAX_CREDIT_MS = 90_000;
export const DUTY_PAP_FRESH_MS = 90_000;

export class DutyPapError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); this.name = "DutyPapError"; }
}
export type DutyPapActor = { corporationId: number; userId: number; userName: string; role: string };
export type DutyPapRuleInput = {
  name: string; eveFleetId: string; currencyId: number | null; awardAmount: string;
  minutesPerAward: number; dailyCap: string; solarSystemIds: number[]; shipTypeIds: number[];
  requireUndocked: boolean; enabled: boolean;
};
export function dutyPapAdmin(actor: DutyPapActor) {
  if (!["admin", "controller"].includes(actor.role)) throw new DutyPapError(403, "DUTY_PAP_ADMIN_REQUIRED", "只有管理员或总监可以管理自动值守规则。");
}
export function dutyPapId(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 2_147_483_647) throw new DutyPapError(400, "DUTY_PAP_INVALID_ID", "编号无效。");
  return Number(value);
}
export function dutyPapFleetId(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new DutyPapError(400, "DUTY_PAP_INVALID_FLEET", "请输入有效的游戏舰队编号。");
  return value;
}
function ids(value: unknown, limit: number): number[] {
  if (!Array.isArray(value) || value.length > limit) throw new DutyPapError(400, "DUTY_PAP_INVALID_FILTER", `筛选最多 ${limit} 项。`);
  return [...new Set(value.map(dutyPapId))].sort((a, b) => a - b);
}
export function dutyPapRuleInput(value: unknown): DutyPapRuleInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new DutyPapError(400, "DUTY_PAP_INVALID_INPUT", "规则内容无效。");
  const body = value as Record<string, unknown>;
  const allowed = ["name", "eveFleetId", "currencyId", "awardAmount", "minutesPerAward", "dailyCap", "solarSystemIds", "shipTypeIds", "requireUndocked", "enabled", "version", "requestId"];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new DutyPapError(400, "DUTY_PAP_INVALID_INPUT", "规则包含不支持的字段。");
  const name = typeof body.name === "string" ? body.name.normalize("NFKC").trim() : "";
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new DutyPapError(400, "DUTY_PAP_INVALID_NAME", "规则名称须为 1–80 字。");
  let amount: bigint, cap: bigint;
  try { amount = parsePapDecimal(body.awardAmount, 6, false, MAX_PAP); cap = parsePapDecimal(body.dailyCap, 6, false, MAX_PAP); }
  catch { throw new DutyPapError(400, "DUTY_PAP_INVALID_AMOUNT", "PAP 数量须为有效数字，最多 6 位小数。"); }
  if (amount <= 0n || cap < amount || amount > 1_000_000n * 1_000_000n || cap > 1_000_000n * 1_000_000n) throw new DutyPapError(400, "DUTY_PAP_INVALID_AMOUNT", "单次及每日数量不超过 1,000,000；每日上限不得小于单次数量。");
  if (!Number.isInteger(body.minutesPerAward) || Number(body.minutesPerAward) < 1 || Number(body.minutesPerAward) > 1440) throw new DutyPapError(400, "DUTY_PAP_INVALID_MINUTES", "每次发放所需时间须为 1–1440 分钟。");
  if (typeof body.enabled !== "boolean" || typeof body.requireUndocked !== "boolean") throw new DutyPapError(400, "DUTY_PAP_INVALID_SWITCH", "请明确填写启用及未停靠条件。");
  return {
    name, eveFleetId: dutyPapFleetId(body.eveFleetId), currencyId: body.currencyId === null ? null : dutyPapId(body.currencyId),
    awardAmount: formatPapUnits(amount), minutesPerAward: Number(body.minutesPerAward), dailyCap: formatPapUnits(cap),
    solarSystemIds: ids(body.solarSystemIds, 50), shipTypeIds: ids(body.shipTypeIds, 100), requireUndocked: body.requireUndocked, enabled: body.enabled,
  };
}
export function dutyPapVersion(value: unknown, current: number) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) >= 2_147_483_646) throw new DutyPapError(400, "DUTY_PAP_INVALID_VERSION", "规则版本无效，请刷新后重试。");
  if (value !== current) throw new DutyPapError(409, "DUTY_PAP_VERSION_CONFLICT", "规则已经被修改，请刷新后重试。");
}
export function dutyPapUtcDay(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new DutyPapError(400, "DUTY_PAP_INVALID_TIME", "观测时间无效。");
  return date.toISOString().slice(0, 10);
}
export function dutyPapElapsed(previous: Date | null, current: Date, previousValid: boolean, sameContext: boolean): number {
  if (!previous || !previousValid || !sameContext || dutyPapUtcDay(previous) !== dutyPapUtcDay(current)) return 0;
  const gap = current.getTime() - previous.getTime();
  if (gap <= 0 || gap > DUTY_PAP_MAX_GAP_MS) return 0;
  return Math.floor(Math.min(gap, DUTY_PAP_MAX_CREDIT_MS) / 1000);
}
