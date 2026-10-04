import { apiUrl } from "@/lib/api";

export type DutyPapRule = {
  id: number;
  name: string;
  eveFleetId: string;
  currencyId: number | null;
  currencyName: string;
  minutesPerAward: number;
  awardAmount: string;
  dailyCap: string;
  solarSystemIds: number[];
  shipTypeIds: number[];
  requireUndocked: boolean;
  enabled: boolean;
  version: number;
  solarSystems?: Array<{ id: number; name: string }>;
  shipTypes?: Array<{ id: number; name: string }>;
  today?: {
    eligibleSeconds: number;
    totalEligibleSeconds: number;
    awardCount: number;
    paidAmount: string;
  };
};
export type DutyPapInput = Pick<
  DutyPapRule,
  | "name"
  | "eveFleetId"
  | "currencyId"
  | "minutesPerAward"
  | "awardAmount"
  | "dailyCap"
  | "solarSystemIds"
  | "shipTypeIds"
  | "requireUndocked"
  | "enabled"
>;
export type DutyPapConnection = {
  id: number;
  characterId: number;
  characterName: string;
  enabled: boolean;
  version: number;
  hasRequiredScopes: boolean;
  status: string;
  statusMessage: string;
  lastCheckedAt: string | null;
  lastObservedAt: string | null;
};
export type DutyPapAward = {
  id: number;
  ruleName: string;
  eveFleetId: string;
  characterName: string;
  day: string;
  amount: string;
  currencyName: string;
  createdAt: string;
  userName?: string;
};
export type DutyPapMine = {
  connection: DutyPapConnection | null;
  characters: Array<{ id: number; eveCharacterId: number; name: string }>;
  rules: DutyPapRule[];
  awards: DutyPapAward[];
  pollIntervalSeconds: number;
  day: string;
  timezone: "UTC";
};
export type DutyPapAdmin = {
  rules: DutyPapRule[];
  currencies: Array<{ id: number; name: string; issuanceEnabled: boolean }>;
  connections: Array<{
    userId: number;
    userName: string;
    characterName: string;
    enabled: boolean;
    status: string;
    statusMessage: string;
    lastCheckedAt: string | null;
  }>;
  awards: DutyPapAward[];
};

export class DutyPapError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "DutyPapError";
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(apiUrl(path), {
      method: options.method ?? "GET",
      credentials: "include",
      headers:
        options.body === undefined
          ? undefined
          : { "Content-Type": "application/json" },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new DutyPapError(
      "连接失败，请刷新核对结果后重试。 / Connection failed. Refresh to check the result before retrying.",
      0,
    );
  }
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const object =
      data && typeof data === "object"
        ? (data as Record<string, unknown>)
        : null;
    const raw = object?.error ?? object?.message;
    const code =
      typeof object?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(object.code)
        ? object.code
        : undefined;
    throw new DutyPapError(
      typeof raw === "string" &&
        code?.startsWith("DUTY_PAP_") &&
        raw.length <= 1000 &&
        !/<\/?[a-z!][^>]*>|bearer\s|access_token|refresh_token/i.test(raw)
        ? raw
        : `请求失败（HTTP ${response.status}），请刷新后重试。 / Request failed. Refresh and retry.`,
      response.status,
      code,
    );
  }
  if (!data || typeof data !== "object")
    throw new DutyPapError(
      "服务器返回异常，请刷新核对。 / Unexpected response. Refresh to check the result.",
      502,
    );
  return data as T;
}

export const dutyPapKeys = {
  all: ["dutyPap"] as const,
  mine: ["dutyPap", "mine"] as const,
  admin: ["dutyPap", "admin"] as const,
};

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const id = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const count = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, max = 1000) =>
  typeof value === "string" && value.length <= max;
const decimal = (value: unknown) =>
  typeof value === "string" &&
  value.length <= 30 &&
  /^\d+(?:\.\d{1,6})?$/.test(value);
const timestamp = (value: unknown) =>
  value === null ||
  (typeof value === "string" && Number.isFinite(new Date(value).getTime()));
const list = (
  value: unknown,
  max: number,
  valid: (value: unknown) => boolean,
) => Array.isArray(value) && value.length <= max && value.every(valid);
function validRule(value: unknown, requiresToday: boolean): boolean {
  const row = object(value);
  if (
    !row ||
    !id(row.id) ||
    !text(row.name, 80) ||
    typeof row.eveFleetId !== "string" ||
    !isDutyFleetId(row.eveFleetId) ||
    !(row.currencyId === null || id(row.currencyId)) ||
    !text(row.currencyName, 200) ||
    !Number.isInteger(row.minutesPerAward) ||
    Number(row.minutesPerAward) < 1 ||
    Number(row.minutesPerAward) > 1440 ||
    !decimal(row.awardAmount) ||
    !decimal(row.dailyCap) ||
    !list(row.solarSystemIds, 50, id) ||
    !list(row.shipTypeIds, 100, id) ||
    typeof row.requireUndocked !== "boolean" ||
    typeof row.enabled !== "boolean" ||
    !count(row.version)
  )
    return false;
  if (
    row.solarSystems !== undefined &&
    !list(row.solarSystems, 50, (value) => {
      const item = object(value);
      return Boolean(item && id(item.id) && text(item.name, 200));
    })
  )
    return false;
  if (
    row.shipTypes !== undefined &&
    !list(row.shipTypes, 100, (value) => {
      const item = object(value);
      return Boolean(item && id(item.id) && text(item.name, 200));
    })
  )
    return false;
  const today = object(row.today);
  return (
    !requiresToday ||
    Boolean(
      today &&
      count(today.eligibleSeconds) &&
      count(today.totalEligibleSeconds) &&
      count(today.awardCount) &&
      decimal(today.paidAmount),
    )
  );
}
function validAward(value: unknown): boolean {
  const row = object(value);
  return Boolean(
    row &&
    id(row.id) &&
    text(row.ruleName, 80) &&
    typeof row.eveFleetId === "string" &&
    isDutyFleetId(row.eveFleetId) &&
    text(row.characterName, 200) &&
    typeof row.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(row.day) &&
    decimal(row.amount) &&
    text(row.currencyName, 200) &&
    typeof row.createdAt === "string" &&
    timestamp(row.createdAt) &&
    (row.userName === undefined || text(row.userName, 200)),
  );
}
export function validateDutyPapMine(value: unknown): value is DutyPapMine {
  const data = object(value);
  if (
    !data ||
    !list(data.characters, 1000, (value) => {
      const row = object(value);
      return Boolean(
        row && id(row.id) && id(row.eveCharacterId) && text(row.name, 200),
      );
    }) ||
    !list(data.rules, 100, (value) => validRule(value, true)) ||
    !list(data.awards, 100, validAward) ||
    data.timezone !== "UTC" ||
    typeof data.day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(data.day) ||
    !Number.isInteger(data.pollIntervalSeconds) ||
    Number(data.pollIntervalSeconds) < 1 ||
    Number(data.pollIntervalSeconds) > 3600
  )
    return false;
  if (data.connection === null) return true;
  const row = object(data.connection);
  return Boolean(
    row &&
    id(row.id) &&
    id(row.characterId) &&
    text(row.characterName, 200) &&
    typeof row.enabled === "boolean" &&
    typeof row.hasRequiredScopes === "boolean" &&
    count(row.version) &&
    text(row.status, 100) &&
    text(row.statusMessage) &&
    timestamp(row.lastCheckedAt) &&
    timestamp(row.lastObservedAt),
  );
}
export function validateDutyPapAdmin(value: unknown): value is DutyPapAdmin {
  const data = object(value);
  return Boolean(
    data &&
    list(data.rules, 100, (value) => validRule(value, false)) &&
    list(data.awards, 200, validAward) &&
    list(data.currencies, 1000, (value) => {
      const row = object(value);
      return Boolean(
        row &&
        id(row.id) &&
        text(row.name, 200) &&
        typeof row.issuanceEnabled === "boolean",
      );
    }) &&
    list(data.connections, 500, (value) => {
      const row = object(value);
      return Boolean(
        row &&
        id(row.userId) &&
        text(row.userName, 200) &&
        text(row.characterName, 200) &&
        typeof row.enabled === "boolean" &&
        text(row.status, 100) &&
        text(row.statusMessage) &&
        timestamp(row.lastCheckedAt),
      );
    }),
  );
}
function verified<T>(value: unknown, valid: (value: unknown) => value is T): T {
  if (!valid(value))
    throw new DutyPapError(
      "值守数据未通过检查，请刷新后重试。 / Duty data could not be verified. Refresh and retry.",
      502,
    );
  return value;
}

export const dutyPapApi = {
  mine: async (signal?: AbortSignal) =>
    verified(
      await request<unknown>("/api/duty-pap", { signal }),
      validateDutyPapMine,
    ),
  admin: async (signal?: AbortSignal) =>
    verified(
      await request<unknown>("/api/admin/duty-pap", { signal }),
      validateDutyPapAdmin,
    ),
  connection: (body: { version: number; enabled: boolean }) =>
    request<{ connection: DutyPapConnection }>("/api/duty-pap/connection", {
      method: "POST",
      body,
    }),
  create: (body: DutyPapInput & { requestId: string }) =>
    request<{ rule: DutyPapRule; replayed: boolean }>(
      "/api/admin/duty-pap/rules",
      { method: "POST", body },
    ),
  update: (id: number, body: DutyPapInput & { version: number }) =>
    request<{ rule: DutyPapRule }>(`/api/admin/duty-pap/rules/${id}`, {
      method: "PUT",
      body,
    }),
  myFleet: async () => {
    try {
      const result = await request<{ fleetId: string; role: string }>(
        "/api/fleets/esi-my-fleet",
      );
      if (!isDutyFleetId(result.fleetId)) throw new Error("Invalid fleet");
      return result;
    } catch {
      throw new DutyPapError(
        "无法读取当前登录角色的舰队。请确认已在舰队中且登录授权有效，或填写明确的舰队编号。 / Could not read your login character's fleet. Check fleet membership and authorization, or enter its explicit fleet ID.",
        502,
      );
    }
  },
};

export function dutyPapRuleInput(rule: DutyPapRule): DutyPapInput {
  return {
    name: rule.name,
    eveFleetId: rule.eveFleetId,
    currencyId: rule.currencyId,
    minutesPerAward: rule.minutesPerAward,
    awardAmount: rule.awardAmount,
    dailyCap: rule.dailyCap,
    solarSystemIds: rule.solarSystemIds,
    shipTypeIds: rule.shipTypeIds,
    requireUndocked: rule.requireUndocked,
    enabled: rule.enabled,
  };
}

export function isDutyFleetId(value: string): boolean {
  return (
    /^[1-9]\d{0,15}$/.test(value) &&
    BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER)
  );
}

export function isDutyCapAtLeastAward(cap: string, amount: string): boolean {
  if (
    !/^\d+(?:\.\d{1,6})?$/.test(cap) ||
    !/^\d+(?:\.\d{1,6})?$/.test(amount) ||
    cap.length > 40 ||
    amount.length > 40
  )
    return false;
  const units = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  };
  return units(cap) >= units(amount);
}

export function formatDutyDuration(seconds: number, zh: boolean): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const minutes = Math.floor(safe / 60);
  return zh ? `${minutes} 分 ${safe % 60} 秒` : `${minutes}m ${safe % 60}s`;
}

export function formatDutyUtc(value: string | null | undefined): string {
  if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
  return `${new Date(value).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function dutyStatusLabel(
  status: string | null | undefined,
  zh: boolean,
): string {
  const labels: Record<string, [string, string]> = {
    eligible: ["正在累计", "Accruing"],
    active: ["正在累计", "Accruing"],
    waiting: ["等待下一次检查", "Awaiting next check"],
    paused: ["已暂停采集", "Collection paused"],
    disabled: ["规则已停用", "Rule disabled"],
    not_in_fleet: ["未加入认可舰队", "Not in a recognized fleet"],
    wrong_fleet: ["未加入认可舰队", "Not in a recognized fleet"],
    offline: ["角色不在线", "Character offline"],
    docked: ["角色已停靠", "Character docked"],
    wrong_system: ["不在允许星系", "Outside allowed systems"],
    wrong_ship: ["未驾驶允许舰种", "Ship not allowed"],
    daily_cap: ["今日已达上限", "Daily limit reached"],
    authorization_required: ["需要重新授权", "Reauthorization required"],
    not_authorized: ["未授权采集", "Collection not authorized"],
    api_error: ["接口异常，待下次核验", "API error; awaiting next check"],
    api_unavailable: ["接口异常，待下次核验", "API error; awaiting next check"],
    unavailable: [
      "接口异常，当前时间未计入",
      "API unavailable; time not counted",
    ],
    rate_limited: [
      "EVE 接口限流，暂停采样，本段不计入",
      "EVE API rate limited; sampling paused, interval not counted",
    ],
    stale_data: ["数据已过期，当前时间未计入", "Stale data; time not counted"],
    observed: ["已确认在岗，等待计时", "Verified; waiting to accrue"],
    unrecognized_fleet: ["舰队尚未被认可", "Fleet not recognized"],
    left_corporation: ["角色已离开军团", "Character left corporation"],
    member_unavailable: ["成员归属已变更", "Member ownership changed"],
    module_disabled: ["军团已关闭功能", "Corporation module disabled"],
    currency_paused: ["该 PAP 已暂停发放", "PAP issuance paused"],
    awaiting_sample: ["等待下一次检查", "Awaiting next check"],
    eligible_baseline: ["已确认在岗，等待计时", "Verified; waiting to accrue"],
    cap_reached: ["今日已达上限", "Daily limit reached"],
    no_matching_rule: ["未加入认可舰队", "Not in a recognized fleet"],
    outside_area: ["不在允许星系", "Outside allowed systems"],
    ship_not_allowed: ["未驾驶允许舰种", "Ship not allowed"],
    error: ["检查失败，未计时", "Check failed; time not counted"],
  };
  const label = labels[status ?? ""] ?? ["等待核验", "Awaiting verification"];
  return label[zh ? 0 : 1];
}

export function dutyAuthorizationErrorLabel(code: string, zh: boolean): string {
  const messages: Record<string, [string, string]> = {
    duty_scopes: [
      "未授予全部值守读取权限，请重新授权并允许舰队、在线、位置和船型读取。",
      "Required duty scopes were not granted. Reauthorize and allow fleet, online, location and ship-type reads.",
    ],
    duty_cancelled: [
      "你取消了 EVE 授权。已有采集设置未变更，可以稍后重新授权。",
      "EVE authorization was cancelled. Existing collection settings are unchanged; you can authorize again later.",
    ],
    duty_character: [
      "EVE 登录角色与网站选定角色不一致，请使用选定的已绑定军团角色授权。",
      "The EVE login did not match the selected character. Authorize using the selected linked corporation character.",
    ],
    duty_changed: [
      "授权期间账号、军团或角色归属发生变化。请刷新页面，重新选择角色并授权。",
      "The account, corporation or character ownership changed during authorization. Refresh, select a character and authorize again.",
    ],
    duty_auth: [
      "EVE 授权校验未完成或已过期，请重新发起授权。已有采集设置未变更。",
      "EVE authorization validation failed or expired. Start authorization again; existing collection settings are unchanged.",
    ],
  };
  return (messages[code] ?? [
    "值守授权未完成，请刷新页面后重新授权。已有采集设置未变更。",
    "Duty authorization was not completed. Refresh and authorize again; existing collection settings are unchanged.",
  ])[zh ? 0 : 1];
}
