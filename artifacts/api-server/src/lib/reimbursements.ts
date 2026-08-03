const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";
const CACHE_TTL_MS = 5 * 60_000;
const MAX_RECENT_LOSSES = 20;
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
  verifiedKillmailCache.set(killmailId, { expiresAt: Date.now() + CACHE_TTL_MS, value: verified });
  return verified;
}

export async function listCharacterLosses(characterId: number): Promise<VerifiedKillmail[]> {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    throw new KillmailValidationError("角色编号无效");
  }
  const cached = characterLossCache.get(characterId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const entries = await fetchJson<ZkillEntry[]>(
    `${ZKILL_BASE}/losses/characterID/${characterId}/page/1/`,
    "zkill",
  );
  if (!Array.isArray(entries)) throw new KillmailValidationError("zKillboard 返回了无效的损失列表");

  const settled = await Promise.allSettled(
    entries
      .filter((entry) => Number.isSafeInteger(Number(entry.killmail_id)) && Boolean(entry.zkb?.hash))
      .slice(0, MAX_RECENT_LOSSES)
      .map((entry) => verifyZkillEntry(entry)),
  );
  const losses = settled
    .flatMap((result) => result.status === "fulfilled" ? [result.value] : [])
    .filter((loss) => loss.victimCharacterId === characterId)
    .sort((left, right) => right.occurredAt.getTime() - left.occurredAt.getTime());
  characterLossCache.set(characterId, { expiresAt: Date.now() + CACHE_TTL_MS, value: losses });
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
