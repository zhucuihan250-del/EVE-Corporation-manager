const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";
const CHARACTER_LOSS_CACHE_TTL_MS = 15 * 60_000;
const VERIFIED_KILLMAIL_CACHE_TTL_MS = 60 * 60_000;
const LOSS_HISTORY_DAYS = 365;
const LOSS_HISTORY_MONTH_BUCKETS = 13;
const MAX_HISTORY_LOSSES = 100;
const ESI_VERIFY_CONCURRENCY = 6;
const ZKILL_REQUEST_DELAY_MS = 500;
const REQUEST_TIMEOUT_MS = 12_000;
const USER_AGENT = "EVE-Corporation-Manager/1.0 https://zephyr-fleet-track-production.up.railway.app";

type ZkillEntry = {
  killmail_id: number;
  zkb?: { hash?: string; totalValue?: number };
};

export type VerifiedKillmail = {
  killmailId: number;
  killmailHash: string;
  occurredAt: Date;
  victimCharacterId: number | null;
  shipTypeId: number;
  shipName: string;
  totalValue: number;
};

export class KillmailValidationError extends Error {}

const verifiedKillmailCache = new Map<number, { expiresAt: number; value: VerifiedKillmail }>();
const characterLossCache = new Map<number, { expiresAt: number; value: VerifiedKillmail[] }>();
const shipNameCache = new Map<number, string>();

function parseKillmailId(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/\/kill\/(\d+)/i) ?? trimmed.match(/killmail_id[=/](\d+)/i);
  return match ? Number(match[1]) : null;
}

async function fetchJson<T>(url: string, source: "zkill" | "esi"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: source === "zkill"
        ? { "Accept-Encoding": "gzip", Accept: "application/json", "User-Agent": USER_AGENT }
        : { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new KillmailValidationError(source === "zkill" ? "zKillboard 暂时无法连接，请稍后重试" : "EVE ESI 暂时无法连接，请稍后重试");
  }
  if (!response.ok) {
    throw new KillmailValidationError(source === "zkill" ? "zKillboard 暂时无法读取损失记录" : "EVE ESI 无法验证该击杀报告");
  }
  try {
    return await response.json() as T;
  } catch {
    throw new KillmailValidationError(source === "zkill" ? "zKillboard 返回了无效数据" : "EVE ESI 返回了无效数据");
  }
}

async function getShipName(shipTypeId: number): Promise<string> {
  const cached = shipNameCache.get(shipTypeId);
  if (cached) return cached;
  try {
    const type = await fetchJson<{ name?: string }>(
      `${ESI_BASE}/universe/types/${shipTypeId}/?datasource=tranquility&language=zh`,
      "esi",
    );
    const name = String(type.name ?? shipTypeId);
    shipNameCache.set(shipTypeId, name);
    return name;
  } catch {
    return String(shipTypeId);
  }
}

async function verifyZkillEntry(entry: ZkillEntry): Promise<VerifiedKillmail> {
  const killmailId = Number(entry.killmail_id);
  const hash = entry.zkb?.hash;
  if (!Number.isSafeInteger(killmailId) || !hash) {
    throw new KillmailValidationError("击杀报告缺少 ESI 验证信息");
  }
  const cached = verifiedKillmailCache.get(killmailId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const killmail = await fetchJson<{
    killmail_id: number;
    killmail_time: string;
    victim: { character_id?: number; ship_type_id: number };
  }>(`${ESI_BASE}/killmails/${killmailId}/${hash}/?datasource=tranquility`, "esi");
  if (killmail.killmail_id !== killmailId || !killmail.victim?.ship_type_id) {
    throw new KillmailValidationError("EVE ESI 返回的击杀报告不完整");
  }
  const verified = {
    killmailId,
    killmailHash: hash,
    occurredAt: new Date(killmail.killmail_time),
    victimCharacterId: killmail.victim.character_id ?? null,
    shipTypeId: killmail.victim.ship_type_id,
    shipName: await getShipName(killmail.victim.ship_type_id),
    totalValue: Number(entry.zkb?.totalValue ?? 0),
  };
  if (Number.isNaN(verified.occurredAt.getTime())) {
    throw new KillmailValidationError("击杀报告的时间无效");
  }
  verifiedKillmailCache.set(killmailId, { expiresAt: Date.now() + VERIFIED_KILLMAIL_CACHE_TTL_MS, value: verified });
  return verified;
}

async function verifyLossEntries(entries: ZkillEntry[]): Promise<VerifiedKillmail[]> {
  const verified: Array<VerifiedKillmail | null> = Array.from({ length: entries.length }, () => null);
  let nextIndex = 0;
  const workerCount = Math.min(ESI_VERIFY_CONCURRENCY, entries.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        verified[index] = await verifyZkillEntry(entries[index]);
      } catch {
        // Ignore individual stale or inaccessible killmails while keeping the rest of the timeline usable.
      }
    }
  }));

  return verified.flatMap((loss) => loss ? [loss] : []);
}

function getLossHistoryMonths(now = new Date()): Array<{ year: number; month: number }> {
  return Array.from({ length: LOSS_HISTORY_MONTH_BUCKETS }, (_, offset) => {
    const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - offset, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  });
}

async function listZkillLossEntries(characterId: number): Promise<ZkillEntry[]> {
  const entriesById = new Map<number, ZkillEntry>();
  const months = getLossHistoryMonths();

  for (let index = 0; index < months.length && entriesById.size < MAX_HISTORY_LOSSES; index += 1) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, ZKILL_REQUEST_DELAY_MS));
    }
    const { year, month } = months[index];
    const monthlyEntries = await fetchJson<ZkillEntry[]>(
      `${ZKILL_BASE}/losses/characterID/${characterId}/year/${year}/month/${month}/page/1/`,
      "zkill",
    );
    if (!Array.isArray(monthlyEntries)) {
      throw new KillmailValidationError("zKillboard 返回了无效的损失列表");
    }
    for (const entry of monthlyEntries) {
      const killmailId = Number(entry.killmail_id);
      if (Number.isSafeInteger(killmailId) && entry.zkb?.hash && !entriesById.has(killmailId)) {
        entriesById.set(killmailId, entry);
      }
    }
  }

  return [...entriesById.values()].slice(0, MAX_HISTORY_LOSSES);
}

export async function listCharacterLosses(characterId: number): Promise<VerifiedKillmail[]> {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new KillmailValidationError("角色编号无效");
  }
  const cached = characterLossCache.get(characterId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const cutoffAt = Date.now() - LOSS_HISTORY_DAYS * 24 * 60 * 60_000;
  const losses = (await verifyLossEntries(await listZkillLossEntries(characterId)))
    .filter((loss) => loss.victimCharacterId === characterId)
    .filter((loss) => loss.occurredAt.getTime() >= cutoffAt)
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
  characterLossCache.set(characterId, { expiresAt: Date.now() + CHARACTER_LOSS_CACHE_TTL_MS, value: losses });
  return losses;
}

export async function verifyKillmail(value: string): Promise<VerifiedKillmail> {
  const killmailId = parseKillmailId(value);
  if (!killmailId || !Number.isSafeInteger(killmailId)) {
    throw new KillmailValidationError("请输入有效的 zKillboard 击杀报告链接或编号");
  }
  const cached = verifiedKillmailCache.get(killmailId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const entries = await fetchJson<ZkillEntry[]>(`${ZKILL_BASE}/killID/${killmailId}/`, "zkill");
  if (!Array.isArray(entries)) throw new KillmailValidationError("zKillboard 返回了无效的击杀报告");
  const entry = entries.find((candidate) => candidate.killmail_id === killmailId);
  if (!entry) throw new KillmailValidationError("无法从 zKillboard 验证该击杀报告");
  return verifyZkillEntry(entry);
}
