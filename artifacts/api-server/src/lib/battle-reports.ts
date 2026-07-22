import { and, asc, eq, lt, ne, or } from "drizzle-orm";
import {
  battleReportKillmailsTable,
  battleReportParticipantsTable,
  battleReportsTable,
  charactersTable,
  db,
  fleetsTable,
  papRecordsTable,
} from "@workspace/db";
import { logger } from "./logger";

const ESI_BASE = "https://esi.evetech.net/latest";
const ZKILL_BASE = "https://zkillboard.com/api";
const ESI_COMPATIBILITY_DATE = "2026-07-20";
const USER_AGENT = process.env.EVE_ESI_USER_AGENT
  || `EVE-PAP-Tracker/1.0 (+${process.env.FRONTEND_URL || "https://workspaceapi-server-production-72ec.up.railway.app"})`;
const MAX_AUTOMATIC_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;
const activeGenerationJobs = new Set<number>();
const queuedGenerationJobs = new Set<number>();
const generationQueue: { reportId: number; force: boolean }[] = [];

type ZkillEntry = {
  killmail_id: number;
  zkb?: {
    hash?: string;
    totalValue?: number;
  };
};

type EsiAttacker = {
  character_id?: number;
  corporation_id?: number;
  alliance_id?: number;
  ship_type_id?: number;
  damage_done: number;
  final_blow: boolean;
};

type EsiKillmail = {
  killmail_id: number;
  killmail_time: string;
  solar_system_id: number;
  victim: {
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    ship_type_id: number;
    damage_taken: number;
  };
  attackers: EsiAttacker[];
};

type UniverseName = {
  id: number;
  name: string;
  category: string;
};

type KillmailCandidate = {
  id: number;
  hash: string;
  totalValue: number;
};

type StoredKillmail = {
  battleReportId: number;
  killmailId: number;
  killmailHash: string;
  killmailTime: Date;
  solarSystemId: number;
  solarSystemName: string | null;
  victimCharacterId: number | null;
  victimCharacterName: string | null;
  victimCorporationId: number | null;
  victimCorporationName: string | null;
  victimAllianceId: number | null;
  victimAllianceName: string | null;
  victimShipTypeId: number;
  victimShipName: string | null;
  victimIsFleetMember: boolean;
  totalValue: number;
  damageTaken: number;
  friendlyDamage: number;
  friendlyAttackers: number;
  finalBlowByFleet: boolean;
  zkillboardUrl: string;
};

function requestHeaders(): Record<string, string> {
  return {
    Accept: "application/json",
    "Accept-Encoding": "gzip",
    "User-Agent": USER_AGENT,
    "X-Compatibility-Date": ESI_COMPATIBILITY_DATE,
  };
}

async function fetchJson<T>(url: string, init?: RequestInit, timeoutMs = 15_000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: { ...requestHeaders(), ...init?.headers },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function resolveUniverseNames(ids: number[]): Promise<Map<number, UniverseName>> {
  const uniqueIds = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const names = new Map<number, UniverseName>();

  for (let offset = 0; offset < uniqueIds.length; offset += 900) {
    const chunk = uniqueIds.slice(offset, offset + 900);
    try {
      const resolved = await fetchJson<UniverseName[]>(
        `${ESI_BASE}/universe/names/?datasource=tranquility`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(chunk),
        },
      );
      for (const entry of resolved) names.set(entry.id, entry);
    } catch (error) {
      logger.warn({ error, idCount: chunk.length }, "Failed to resolve ESI universe names for battle report");
    }
  }

  return names;
}

async function fetchZkillCandidates(
  entityType: "corporationID" | "characterID",
  entityId: number,
  pastSeconds: number,
): Promise<ZkillEntry[]> {
  return fetchJson<ZkillEntry[]>(
    `${ZKILL_BASE}/${entityType}/${entityId}/pastSeconds/${pastSeconds}/`,
    undefined,
    20_000,
  );
}

async function fetchKillmailDetails(candidates: KillmailCandidate[]): Promise<{
  details: { candidate: KillmailCandidate; killmail: EsiKillmail }[];
  failures: number;
}> {
  const details: { candidate: KillmailCandidate; killmail: EsiKillmail }[] = [];
  let failures = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const candidate = candidates[cursor++];
      try {
        const killmail = await fetchJson<EsiKillmail>(
          `${ESI_BASE}/killmails/${candidate.id}/${candidate.hash}/?datasource=tranquility`,
        );
        details.push({ candidate, killmail });
      } catch (error) {
        failures++;
        logger.warn({ error, killmailId: candidate.id }, "Failed to fetch ESI killmail for battle report");
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, () => worker()));
  return { details, failures };
}

export async function ensureBattleReportForFleet(fleetId: number): Promise<number | null> {
  const [fleet] = await db.select().from(fleetsTable).where(eq(fleetsTable.id, fleetId));
  if (!fleet || fleet.isActive || !fleet.endedAt) return null;

  let [report] = await db
    .insert(battleReportsTable)
    .values({
      fleetId: fleet.id,
      fleetName: fleet.name,
      fleetCommander: fleet.fleetCommander,
      startedAt: fleet.startedAt ?? fleet.createdAt,
      endedAt: fleet.endedAt,
      status: "pending",
    })
    .onConflictDoNothing({ target: battleReportsTable.fleetId })
    .returning({ id: battleReportsTable.id });

  if (!report) {
    [report] = await db
      .select({ id: battleReportsTable.id })
      .from(battleReportsTable)
      .where(eq(battleReportsTable.fleetId, fleet.id));
  }
  if (!report) return null;

  const participants = await db
    .select({
      userId: papRecordsTable.userId,
      characterId: charactersTable.id,
      eveCharacterId: charactersTable.eveCharacterId,
      characterName: charactersTable.eveCharacterName,
      corporationId: charactersTable.corporationId,
      corporationName: charactersTable.corporationName,
    })
    .from(papRecordsTable)
    .innerJoin(charactersTable, eq(papRecordsTable.characterId, charactersTable.id))
    .where(and(eq(papRecordsTable.fleetId, fleet.id), eq(papRecordsTable.type, "fleet")))
    .orderBy(asc(papRecordsTable.createdAt));

  const uniqueParticipants = [...new Map(participants.map((participant) => [participant.eveCharacterId, participant])).values()];
  if (uniqueParticipants.length > 0) {
    await db
      .insert(battleReportParticipantsTable)
      .values(uniqueParticipants.map((participant) => ({ battleReportId: report.id, ...participant })))
      .onConflictDoNothing();
  }

  return report.id;
}

async function runBattleReportGeneration(reportId: number, force: boolean): Promise<void> {
  const staleGenerationThreshold = new Date(Date.now() - 5 * 60_000);
  const claimCondition = force
    ? and(eq(battleReportsTable.id, reportId), or(ne(battleReportsTable.status, "generating"), lt(battleReportsTable.updatedAt, staleGenerationThreshold)))
    : and(
        eq(battleReportsTable.id, reportId),
        or(
          eq(battleReportsTable.status, "pending"),
          eq(battleReportsTable.status, "failed"),
          and(eq(battleReportsTable.status, "generating"), lt(battleReportsTable.updatedAt, staleGenerationThreshold)),
        ),
      );

  const [claimed] = await db
    .update(battleReportsTable)
    .set({ status: "generating", errorMessage: null, updatedAt: new Date() })
    .where(claimCondition)
    .returning();
  if (!claimed) return;

  const participants = await db
    .select()
    .from(battleReportParticipantsTable)
    .where(eq(battleReportParticipantsTable.battleReportId, reportId));

  if (participants.length === 0) {
    await db
      .update(battleReportsTable)
      .set({
        status: "partial",
        errorMessage: "No recorded fleet participants were available for killmail matching.",
        generatedAt: new Date(),
        lastSyncedAt: new Date(),
      })
      .where(eq(battleReportsTable.id, reportId));
    return;
  }

  const now = Date.now();
  const lookbackSeconds = Math.ceil((now - claimed.startedAt.getTime()) / 3_600_000) * 3_600;
  if (lookbackSeconds > MAX_AUTOMATIC_LOOKBACK_SECONDS) {
    await db
      .update(battleReportsTable)
      .set({
        status: "failed",
        errorMessage: "This fleet is outside zKillboard's seven-day automatic lookup window.",
        generatedAt: new Date(),
        lastSyncedAt: new Date(),
      })
      .where(eq(battleReportsTable.id, reportId));
    return;
  }

  const pastSeconds = Math.max(3_600, Math.min(MAX_AUTOMATIC_LOOKBACK_SECONDS, lookbackSeconds));
  const corporationIds = [...new Set(participants.map((participant) => participant.corporationId).filter((id): id is number => id !== null))];
  const corporationParticipantIds = new Set(
    participants.filter((participant) => participant.corporationId !== null).map((participant) => participant.eveCharacterId),
  );
  const characterIds = participants
    .filter((participant) => !corporationParticipantIds.has(participant.eveCharacterId))
    .map((participant) => participant.eveCharacterId);

  const candidateMap = new Map<number, KillmailCandidate>();
  const sourceErrors: string[] = [];
  const sources: { type: "corporationID" | "characterID"; id: number }[] = [
    ...corporationIds.map((id) => ({ type: "corporationID" as const, id })),
    ...characterIds.map((id) => ({ type: "characterID" as const, id })),
  ];

  for (const [index, source] of sources.entries()) {
    if (index > 0) await delay(400);
    try {
      const entries = await fetchZkillCandidates(source.type, source.id, pastSeconds);
      for (const entry of entries) {
        const hash = entry.zkb?.hash;
        if (!hash || !Number.isInteger(entry.killmail_id)) continue;
        candidateMap.set(entry.killmail_id, {
          id: entry.killmail_id,
          hash,
          totalValue: Number(entry.zkb?.totalValue ?? 0),
        });
      }
    } catch (error) {
      sourceErrors.push(`${source.type}:${source.id}`);
      logger.warn({ error, source }, "zKillboard battle report source failed");
    }
  }

  const participantIds = new Set(participants.map((participant) => participant.eveCharacterId));
  const { details, failures: detailFailures } = await fetchKillmailDetails([...candidateMap.values()]);
  const matching = details.filter(({ killmail }) => {
    const time = new Date(killmail.killmail_time).getTime();
    if (time < claimed.startedAt.getTime() || time > claimed.endedAt.getTime()) return false;
    if (killmail.victim.character_id && participantIds.has(killmail.victim.character_id)) return true;
    return killmail.attackers.some((attacker) => attacker.character_id && participantIds.has(attacker.character_id));
  });

  const idsToResolve: number[] = [];
  for (const { killmail } of matching) {
    idsToResolve.push(killmail.solar_system_id, killmail.victim.ship_type_id);
    if (killmail.victim.character_id) idsToResolve.push(killmail.victim.character_id);
    if (killmail.victim.corporation_id) idsToResolve.push(killmail.victim.corporation_id);
    if (killmail.victim.alliance_id) idsToResolve.push(killmail.victim.alliance_id);
    for (const attacker of killmail.attackers) {
      if (attacker.ship_type_id) idsToResolve.push(attacker.ship_type_id);
    }
  }
  const names = await resolveUniverseNames(idsToResolve);

  const participantStats = new Map<number, {
    damageDealt: number;
    killsInvolved: number;
    finalBlows: number;
    losses: number;
    ships: Map<number, number>;
  }>();
  for (const participant of participants) {
    participantStats.set(participant.eveCharacterId, {
      damageDealt: 0,
      killsInvolved: 0,
      finalBlows: 0,
      losses: 0,
      ships: new Map(),
    });
  }

  const storedKillmails: StoredKillmail[] = [];
  const systemCounts = new Map<number, number>();
  let totalDestroyed = 0;
  let totalLost = 0;
  let totalDamageDealt = 0;
  let friendlyLosses = 0;
  let hostileLosses = 0;

  for (const { candidate, killmail } of matching) {
    const victimCharacterId = killmail.victim.character_id ?? null;
    const victimIsFleetMember = victimCharacterId !== null && participantIds.has(victimCharacterId);
    const friendlyAttackers = killmail.attackers.filter(
      (attacker) => attacker.character_id && participantIds.has(attacker.character_id),
    );
    const friendlyDamage = friendlyAttackers.reduce((sum, attacker) => sum + attacker.damage_done, 0);
    const finalBlowByFleet = friendlyAttackers.some((attacker) => attacker.final_blow);

    if (victimIsFleetMember) {
      friendlyLosses++;
      totalLost += candidate.totalValue;
      const victimStats = victimCharacterId ? participantStats.get(victimCharacterId) : undefined;
      if (victimStats) victimStats.losses++;
    } else {
      hostileLosses++;
      totalDestroyed += candidate.totalValue;
    }

    totalDamageDealt += friendlyDamage;
    systemCounts.set(killmail.solar_system_id, (systemCounts.get(killmail.solar_system_id) ?? 0) + 1);

    for (const attacker of friendlyAttackers) {
      if (!attacker.character_id) continue;
      const stats = participantStats.get(attacker.character_id);
      if (!stats) continue;
      stats.damageDealt += attacker.damage_done;
      stats.killsInvolved++;
      if (attacker.final_blow) stats.finalBlows++;
      if (attacker.ship_type_id) {
        stats.ships.set(attacker.ship_type_id, (stats.ships.get(attacker.ship_type_id) ?? 0) + 1);
      }
    }

    storedKillmails.push({
      battleReportId: reportId,
      killmailId: killmail.killmail_id,
      killmailHash: candidate.hash,
      killmailTime: new Date(killmail.killmail_time),
      solarSystemId: killmail.solar_system_id,
      solarSystemName: names.get(killmail.solar_system_id)?.name ?? null,
      victimCharacterId,
      victimCharacterName: victimCharacterId ? names.get(victimCharacterId)?.name ?? null : null,
      victimCorporationId: killmail.victim.corporation_id ?? null,
      victimCorporationName: killmail.victim.corporation_id
        ? names.get(killmail.victim.corporation_id)?.name ?? null
        : null,
      victimAllianceId: killmail.victim.alliance_id ?? null,
      victimAllianceName: killmail.victim.alliance_id
        ? names.get(killmail.victim.alliance_id)?.name ?? null
        : null,
      victimShipTypeId: killmail.victim.ship_type_id,
      victimShipName: names.get(killmail.victim.ship_type_id)?.name ?? null,
      victimIsFleetMember,
      totalValue: candidate.totalValue,
      damageTaken: killmail.victim.damage_taken,
      friendlyDamage,
      friendlyAttackers: friendlyAttackers.length,
      finalBlowByFleet,
      zkillboardUrl: `https://zkillboard.com/kill/${killmail.killmail_id}/`,
    });
  }

  const [primarySystem] = [...systemCounts.entries()].sort((left, right) => right[1] - left[1])[0] ?? [];
  const warnings: string[] = [];
  if (sourceErrors.length > 0) warnings.push(`${sourceErrors.length} zKillboard source(s) failed`);
  if (detailFailures > 0) warnings.push(`${detailFailures} ESI killmail(s) failed`);
  const allSourcesFailed = sources.length > 0 && sourceErrors.length === sources.length;
  const finalStatus = allSourcesFailed ? "failed" : warnings.length > 0 ? "partial" : "ready";
  const syncedAt = new Date();

  await db.transaction(async (tx) => {
    await tx.delete(battleReportKillmailsTable).where(eq(battleReportKillmailsTable.battleReportId, reportId));
    if (storedKillmails.length > 0) await tx.insert(battleReportKillmailsTable).values(storedKillmails);

    for (const participant of participants) {
      const stats = participantStats.get(participant.eveCharacterId)!;
      const primaryShipTypeId = [...stats.ships.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null;
      await tx
        .update(battleReportParticipantsTable)
        .set({
          primaryShipTypeId,
          primaryShipName: primaryShipTypeId ? names.get(primaryShipTypeId)?.name ?? null : null,
          damageDealt: stats.damageDealt,
          killsInvolved: stats.killsInvolved,
          finalBlows: stats.finalBlows,
          losses: stats.losses,
        })
        .where(eq(battleReportParticipantsTable.id, participant.id));
    }

    await tx
      .update(battleReportsTable)
      .set({
        status: finalStatus,
        errorMessage: warnings.length > 0 ? warnings.join("; ") : null,
        totalDestroyed,
        totalLost,
        damageDealt: totalDamageDealt,
        killmailCount: storedKillmails.length,
        friendlyLosses,
        hostileLosses,
        primarySystemId: primarySystem ?? null,
        primarySystemName: primarySystem ? names.get(primarySystem)?.name ?? null : null,
        generatedAt: syncedAt,
        lastSyncedAt: syncedAt,
        updatedAt: syncedAt,
      })
      .where(eq(battleReportsTable.id, reportId));
  });

  logger.info(
    { reportId, killmailCount: storedKillmails.length, participantCount: participants.length, status: finalStatus },
    "Battle report generation complete",
  );
}

function drainGenerationQueue(): void {
  if (activeGenerationJobs.size > 0) return;
  const next = generationQueue.shift();
  if (!next) return;

  const { reportId, force } = next;
  queuedGenerationJobs.delete(reportId);
  activeGenerationJobs.add(reportId);
  void runBattleReportGeneration(reportId, force)
    .catch(async (error) => {
      logger.error({ error, reportId }, "Battle report generation failed");
      await db
        .update(battleReportsTable)
        .set({
          status: "failed",
          errorMessage: error instanceof Error ? error.message.slice(0, 500) : "Unknown generation error",
          lastSyncedAt: new Date(),
        })
        .where(eq(battleReportsTable.id, reportId))
        .catch((updateError) => logger.error({ updateError, reportId }, "Failed to persist battle report error"));
    })
    .finally(() => {
      activeGenerationJobs.delete(reportId);
      drainGenerationQueue();
    });
}

export function queueBattleReportGeneration(reportId: number, force = false): void {
  if (activeGenerationJobs.has(reportId) || queuedGenerationJobs.has(reportId)) return;
  queuedGenerationJobs.add(reportId);
  generationQueue.push({ reportId, force });
  drainGenerationQueue();
}
