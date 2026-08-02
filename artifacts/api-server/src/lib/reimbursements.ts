const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";

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

function parseKillmailId(value: string): number | null {
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const match = trimmed.match(/\/kill\/(\d+)/i) ?? trimmed.match(/killmail_id[=/](\d+)/i);
  return match ? Number(match[1]) : null;
}

export async function verifyKillmail(value: string): Promise<VerifiedKillmail> {
  const killmailId = parseKillmailId(value);
  if (!killmailId || !Number.isSafeInteger(killmailId)) {
    throw new KillmailValidationError("请输入有效的 zKillboard 击杀报告链接或编号");
  }
  const zkillResponse = await fetch(`${ZKILL_BASE}/killID/${killmailId}/`, {
    headers: { "User-Agent": "EVE-Corporation-Manager/1.0" },
  });
  if (!zkillResponse.ok) {
    throw new KillmailValidationError("无法从 zKillboard 验证该击杀报告");
  }
  const entries = (await zkillResponse.json()) as ZkillEntry[];
  const entry = entries.find((candidate) => candidate.killmail_id === killmailId);
  const hash = entry?.zkb?.hash;
  if (!hash) throw new KillmailValidationError("击杀报告缺少 ESI 验证哈希");

  const esiResponse = await fetch(
    `${ESI_BASE}/killmails/${killmailId}/${hash}/?datasource=tranquility`,
  );
  if (!esiResponse.ok) {
    throw new KillmailValidationError("EVE ESI 无法验证该击杀报告");
  }
  const killmail = (await esiResponse.json()) as {
    killmail_id: number;
    killmail_time: string;
    victim: { character_id?: number; ship_type_id: number };
  };
  const typeResponse = await fetch(
    `${ESI_BASE}/universe/types/${killmail.victim.ship_type_id}/?datasource=tranquility&language=zh`,
  );
  const shipName = typeResponse.ok
    ? String(((await typeResponse.json()) as { name?: string }).name ?? killmail.victim.ship_type_id)
    : String(killmail.victim.ship_type_id);
  return {
    killmailId,
    killmailHash: hash,
    occurredAt: new Date(killmail.killmail_time),
    victimCharacterId: killmail.victim.character_id ?? null,
    shipTypeId: killmail.victim.ship_type_id,
    shipName,
    totalValue: Number(entry?.zkb?.totalValue ?? 0),
  };
}
