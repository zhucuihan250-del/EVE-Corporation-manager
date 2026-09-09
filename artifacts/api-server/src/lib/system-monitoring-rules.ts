import { createHash } from "node:crypto";

export type MonitorIdentity = {
  id: number;
  solarSystemId: number;
  solarSystemName: string;
};

export type ParsedIntelMessage = {
  monitor: MonitorIdentity;
  enemyCount: number | null;
  shipTags: string[];
  direction: string | null;
  ttlMinutes: number;
  severity: "info" | "warning" | "danger" | "critical";
};

export type R2Z2Killmail = {
  killmail_id: number;
  killmail_time: string;
  solar_system_id: number;
  victim: {
    character_id?: number;
    corporation_id?: number;
    ship_type_id?: number;
  };
  attackers?: Array<{ character_id?: number; ship_type_id?: number }>;
  zkb?: { totalValue?: number; npc?: boolean };
};

export const MAX_INTEL_TTL_MINUTES = 25;
export const MIN_DYNAMIC_INTEL_TTL_MINUTES = 5;
export const MANUAL_INTEL_TTL_OPTIONS = [5, 10, 15, 20, 25] as const;

export type DynamicIntelLifetimeInput = {
  killCount?: number | null;
  participantCount?: number | null;
  hostileCount?: number | null;
};

function nonNegativeInteger(value: number | null | undefined): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value ?? 0));
}

/**
 * Base 5 minutes, plus 2 minutes per player kill, plus 1 minute per 3
 * reported hostiles or observed player participants, capped at 25.
 */
export function calculateDynamicIntelTtlMinutes(
  input: DynamicIntelLifetimeInput,
): number {
  const killMinutes = nonNegativeInteger(input.killCount) * 2;
  const participantMinutes = Math.ceil(
    nonNegativeInteger(input.participantCount ?? input.hostileCount) / 3,
  );
  return Math.min(
    MAX_INTEL_TTL_MINUTES,
    MIN_DYNAMIC_INTEL_TTL_MINUTES + killMinutes + participantMinutes,
  );
}

export function capIntelTtlMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return MAX_INTEL_TTL_MINUTES;
  return Math.min(MAX_INTEL_TTL_MINUTES, Math.max(0, minutes));
}

export function intelExpiresAt(
  occurredAt: Date,
  requestedMinutes = MAX_INTEL_TTL_MINUTES,
): Date {
  return new Date(
    occurredAt.getTime() + capIntelTtlMinutes(requestedMinutes) * 60 * 1_000,
  );
}

export function effectiveIntelExpiresAt(
  occurredAt: Date,
  storedExpiresAt: Date | null,
): Date {
  const maximumExpiresAt = intelExpiresAt(occurredAt);
  if (
    !storedExpiresAt ||
    !Number.isFinite(storedExpiresAt.getTime()) ||
    storedExpiresAt.getTime() > maximumExpiresAt.getTime()
  ) {
    return maximumExpiresAt;
  }
  return storedExpiresAt;
}

export function killmailAffectsSystemRisk(
  killmail: Pick<R2Z2Killmail, "zkb">,
): boolean {
  return killmail.zkb?.npc !== true;
}

export function getPlayerAttackerIds(
  killmail: Pick<R2Z2Killmail, "attackers">,
): number[] {
  return [
    ...new Set(
      (killmail.attackers ?? []).flatMap((attacker) =>
        Number.isInteger(attacker.character_id) ? [attacker.character_id!] : [],
      ),
    ),
  ];
}

export function countPlayerParticipants(
  killmail: Pick<R2Z2Killmail, "attackers">,
): number {
  return getPlayerAttackerIds(killmail).length;
}

export function countUniquePlayerParticipants(
  events: Array<{ playerAttackerIds?: unknown }>,
): number {
  return new Set(
    events.flatMap((event) =>
      Array.isArray(event.playerAttackerIds)
        ? event.playerAttackerIds.filter((characterId): characterId is number =>
            Number.isInteger(characterId),
          )
        : [],
    ),
  ).size;
}

export function countPlayerKills(activity: {
  shipKills: number;
  podKills: number;
  npcKills?: number;
}): number {
  return activity.shipKills + activity.podKills;
}

const SHIP_TAGS: Array<[string, RegExp]> = [
  [
    "旗舰",
    /旗舰|capital|titan|泰坦|无畏|dread|航母|carrier|超旗|supercarrier|fax|战力辅助/i,
  ],
  ["黑隐", /黑隐|black\s*ops|blops|罪恶|寡妇|救赎|元帅/i],
  ["泡泡船", /泡泡|重拦|轻拦|hic|dictor|interdictor|interdiction/i],
  ["战列舰", /战列|battleship|\bbs\b/i],
  ["战巡", /战巡|battlecruiser|\bbc\b/i],
  ["巡洋舰", /巡洋|cruiser/i],
  ["后勤", /后勤|logi|logistics/i],
  ["隐轰", /隐轰|stealth\s*bomber|bomber/i],
  ["工业舰", /工业|industrial|运输|hauler/i],
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function messageContainsSystem(
  message: string,
  systemName: string,
): boolean {
  const pattern = new RegExp(
    `(^|[^A-Z0-9-])${escapeRegExp(systemName)}($|[^A-Z0-9-])`,
    "i",
  );
  return pattern.test(message);
}

function parseEnemyCount(message: string): number | null {
  const explicit = message.match(
    /(?:\+\s*|敌对\s*|红\s*|hostiles?\s*[:=]?\s*)(\d{1,3})/i,
  );
  if (explicit) return Number(explicit[1]);
  const suffixed = message.match(/(\d{1,3})\s*(?:人|红|敌对|hostiles?)/i);
  return suffixed ? Number(suffixed[1]) : null;
}

function parseDirection(message: string): string | null {
  const match = message.match(/(?:前往|去往|驶向|向|->|→)\s*([A-Z0-9-]{2,})/i);
  return match?.[1] ?? null;
}

function parseTtl(message: string): number {
  const match = message.match(/\bttl\s*[:=]?\s*(\d{1,3})\b/i);
  if (!match) return 10;
  return Math.max(5, capIntelTtlMinutes(Number(match[1])));
}

export function parseIntelMessage(
  message: string,
  monitors: MonitorIdentity[],
): ParsedIntelMessage | null {
  const monitor = [...monitors]
    .sort(
      (left, right) =>
        right.solarSystemName.length - left.solarSystemName.length,
    )
    .find((candidate) =>
      messageContainsSystem(message, candidate.solarSystemName),
    );
  if (!monitor) return null;

  const enemyCount = parseEnemyCount(message);
  const shipTags = SHIP_TAGS.flatMap(([tag, pattern]) =>
    pattern.test(message) ? [tag] : [],
  );
  const severity =
    enemyCount !== null && enemyCount >= 20
      ? "critical"
      : (enemyCount !== null && enemyCount >= 8) ||
          shipTags.some((tag) => ["旗舰", "黑隐", "泡泡船"].includes(tag))
        ? "danger"
        : "warning";

  return {
    monitor,
    enemyCount,
    shipTags,
    direction: parseDirection(message),
    ttlMinutes: parseTtl(message),
    severity,
  };
}

export function intelDedupeKey(
  parts: Array<string | number | null | undefined>,
): string {
  const normalized = parts
    .map((part) =>
      String(part ?? "")
        .trim()
        .toLocaleLowerCase(),
    )
    .join("|");
  return createHash("sha256").update(normalized).digest("hex");
}

export const CAPITAL_GROUP_IDS = new Set([
  30, 485, 547, 659, 883, 1538, 4594, 5120,
]);
export const BLACK_OPS_GROUP_IDS = new Set([898]);
export const INTERDICTOR_GROUP_IDS = new Set([541, 894]);

export function classifyShipGroups(groupIds: number[]): {
  capital: boolean;
  blackOps: boolean;
  interdictor: boolean;
} {
  return {
    capital: groupIds.some((id) => CAPITAL_GROUP_IDS.has(id)),
    blackOps: groupIds.some((id) => BLACK_OPS_GROUP_IDS.has(id)),
    interdictor: groupIds.some((id) => INTERDICTOR_GROUP_IDS.has(id)),
  };
}

export function highestSeverity(
  values: Array<"info" | "warning" | "danger" | "critical">,
): "safe" | "info" | "warning" | "danger" | "critical" {
  const levels = ["info", "warning", "danger", "critical"] as const;
  let index = -1;
  for (const value of values) index = Math.max(index, levels.indexOf(value));
  return index < 0 ? "safe" : levels[index];
}

export function extractR2Z2Killmail(payload: unknown): R2Z2Killmail | null {
  if (!payload || typeof payload !== "object") return null;
  const candidate = payload as Record<string, unknown>;
  const raw =
    candidate.esi && typeof candidate.esi === "object"
      ? (candidate.esi as Record<string, unknown>)
      : candidate.killmail && typeof candidate.killmail === "object"
        ? (candidate.killmail as Record<string, unknown>)
        : candidate;
  const killmailId = Number(raw.killmail_id ?? candidate.killmail_id);
  const solarSystemId = Number(raw.solar_system_id);
  if (
    !Number.isInteger(killmailId) ||
    !Number.isInteger(solarSystemId) ||
    typeof raw.killmail_time !== "string"
  ) {
    return null;
  }
  const victim =
    raw.victim && typeof raw.victim === "object"
      ? (raw.victim as R2Z2Killmail["victim"])
      : {};
  const attackers = Array.isArray(raw.attackers)
    ? (raw.attackers as R2Z2Killmail["attackers"])
    : [];
  const zkb =
    candidate.zkb && typeof candidate.zkb === "object"
      ? (candidate.zkb as R2Z2Killmail["zkb"])
      : raw.zkb && typeof raw.zkb === "object"
        ? (raw.zkb as R2Z2Killmail["zkb"])
        : undefined;
  return {
    killmail_id: killmailId,
    killmail_time: raw.killmail_time,
    solar_system_id: solarSystemId,
    victim,
    attackers,
    zkb,
  };
}
