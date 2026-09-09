import {
  db,
  corporationsTable,
  monitoredSystemsTable,
  systemActivitySamplesTable,
  systemIntelEventsTable,
  systemMonitorFeedStateTable,
  pool,
} from "@workspace/db";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import {
  calculateDynamicIntelTtlMinutes,
  classifyShipGroups,
  countPlayerParticipants,
  countPlayerKills,
  countUniquePlayerParticipants,
  extractR2Z2Killmail,
  getPlayerAttackerIds,
  intelExpiresAt,
  intelDedupeKey,
  killmailAffectsSystemRisk,
  type R2Z2Killmail,
} from "./system-monitoring-rules";
import { cleanupExpiredPairings } from "./system-monitoring";
import { logger } from "./logger";

const R2Z2_SEQUENCE_URL = "https://r2z2.zkillboard.com/ephemeral/sequence.json";
const R2Z2_POLL_INTERVAL_MS = 6_000;
const R2Z2_SEQUENCE_FETCH_DELAY_MS = 100;
const ACTIVITY_SYNC_INTERVAL_MS = 55 * 60 * 1_000;
const EXTERNAL_FETCH_TIMEOUT_MS = 12_000;
const MAX_SEQUENCES_PER_SWEEP = 200;

type EveTypeInfo = { name: string; groupId: number };
const typeCache = new Map<number, { value: EveTypeInfo; expiresAt: number }>();
const characterNameCache = new Map<
  number,
  { value: string; expiresAt: number }
>();

async function externalJson(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "EVE-Corporation-manager/system-monitoring",
      ...(init?.headers ?? {}),
    },
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS),
  });
}

async function resolveType(typeId: number): Promise<EveTypeInfo | null> {
  const cached = typeCache.get(typeId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const response = await externalJson(
      `https://esi.evetech.net/universe/types/${typeId}/?datasource=tranquility&language=en`,
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      name?: string;
      group_id?: number;
    };
    if (!payload.name || !Number.isInteger(payload.group_id)) return null;
    const value = { name: payload.name, groupId: payload.group_id! };
    typeCache.set(typeId, {
      value,
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
    });
    return value;
  } catch {
    return null;
  }
}

async function resolveCharacterName(
  characterId: number,
): Promise<string | null> {
  const cached = characterNameCache.get(characterId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  try {
    const response = await externalJson(
      `https://esi.evetech.net/characters/${characterId}/?datasource=tranquility`,
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { name?: string };
    if (!payload.name) return null;
    characterNameCache.set(characterId, {
      value: payload.name,
      expiresAt: Date.now() + 24 * 60 * 60 * 1_000,
    });
    return payload.name;
  } catch {
    return null;
  }
}

function formatIsk(value: number): string {
  if (value >= 1_000_000_000)
    return `${(value / 1_000_000_000).toFixed(2)}b ISK`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m ISK`;
  return `${Math.round(value).toLocaleString("en-US")} ISK`;
}

async function processKillmail(killmail: R2Z2Killmail) {
  if (!killmailAffectsSystemRisk(killmail)) return;

  const monitorRows = await db
    .select({ monitor: monitoredSystemsTable })
    .from(monitoredSystemsTable)
    .innerJoin(
      corporationsTable,
      and(
        eq(corporationsTable.id, monitoredSystemsTable.corporationId),
        eq(corporationsTable.isActive, true),
        eq(corporationsTable.fleetEnabled, true),
      ),
    )
    .where(
      and(
        eq(monitoredSystemsTable.solarSystemId, killmail.solar_system_id),
        eq(monitoredSystemsTable.isActive, true),
      ),
    );
  const monitors = monitorRows.map((row) => row.monitor);
  if (monitors.length === 0) return;

  const typeIds = [
    ...new Set(
      [
        killmail.victim.ship_type_id,
        ...(killmail.attackers ?? []).map((attacker) => attacker.ship_type_id),
      ].filter((value): value is number => Number.isInteger(value)),
    ),
  ].slice(0, 30);
  const typePairs = await Promise.all(
    typeIds.map(async (typeId) => [typeId, await resolveType(typeId)] as const),
  );
  const typeInfo = new Map(typePairs);
  const groupIds = typePairs.flatMap(([, info]) =>
    info ? [info.groupId] : [],
  );
  const classification = classifyShipGroups(groupIds);
  const victimShip = killmail.victim.ship_type_id
    ? (typeInfo.get(killmail.victim.ship_type_id)?.name ?? null)
    : null;
  const victimName = killmail.victim.character_id
    ? await resolveCharacterName(killmail.victim.character_id)
    : null;
  const totalValue = Number(killmail.zkb?.totalValue ?? 0);
  const playerAttackerIds = getPlayerAttackerIds(killmail);
  const playerParticipantCount = countPlayerParticipants(killmail);
  const killTtlMinutes = calculateDynamicIntelTtlMinutes({
    killCount: 1,
    participantCount: playerParticipantCount,
  });
  const occurredAt = new Date(killmail.killmail_time);
  if (Number.isNaN(occurredAt.getTime())) return;

  for (const monitor of monitors) {
    const friendlyLoss =
      killmail.victim.corporation_id === monitor.corporationId;
    const highValue = totalValue >= Number(monitor.highValueThreshold);
    const special =
      classification.capital ||
      classification.blackOps ||
      classification.interdictor;
    const eventType = friendlyLoss
      ? "corporation_loss"
      : special
        ? "special_ship"
        : highValue
          ? "high_value"
          : "player_kill";
    const severity =
      friendlyLoss || highValue ? "critical" : special ? "danger" : "warning";
    const shipTags = [
      ...(classification.capital ? ["旗舰"] : []),
      ...(classification.blackOps ? ["黑隐"] : []),
      ...(classification.interdictor ? ["泡泡船"] : []),
    ];
    const victimLabel =
      victimName ??
      (killmail.victim.character_id
        ? `角色 #${killmail.victim.character_id}`
        : "一名玩家");
    const summary = friendlyLoss
      ? `本军团成员在 ${monitor.solarSystemName} 损失 ${victimShip ?? "舰船"}${totalValue > 0 ? `（${formatIsk(totalValue)}）` : ""}`
      : `${monitor.solarSystemName} 出现玩家击杀：${victimLabel} / ${victimShip ?? "未知舰船"}${totalValue > 0 ? ` / ${formatIsk(totalValue)}` : ""}`;
    const [created] = await db
      .insert(systemIntelEventsTable)
      .values({
        corporationId: monitor.corporationId,
        monitorId: monitor.id,
        source: "killmail",
        eventType,
        severity,
        confidence: "confirmed",
        solarSystemId: monitor.solarSystemId,
        solarSystemName: monitor.solarSystemName,
        summary,
        shipTags,
        killmailId: killmail.killmail_id,
        zkillboardUrl: `https://zkillboard.com/kill/${killmail.killmail_id}/`,
        totalValue,
        metadata: {
          sourceEventId: String(killmail.killmail_id),
          victimCharacterId: killmail.victim.character_id ?? null,
          victimCorporationId: killmail.victim.corporation_id ?? null,
          victimShipTypeId: killmail.victim.ship_type_id ?? null,
          victimShipName: victimShip,
          ...classification,
          friendlyLoss,
          playerAttackerIds,
          playerParticipantCount,
        },
        occurredAt,
        expiresAt: intelExpiresAt(occurredAt, killTtlMinutes),
        dedupeKey: intelDedupeKey([
          "killmail",
          monitor.id,
          killmail.killmail_id,
        ]),
      })
      .onConflictDoNothing()
      .returning({ id: systemIntelEventsTable.id });
    if (!created) continue;

    const windowStart = new Date(
      occurredAt.getTime() - monitor.burstWindowMinutes * 60 * 1_000,
    );
    const recentKills = await db
      .select({ metadata: systemIntelEventsTable.metadata })
      .from(systemIntelEventsTable)
      .where(
        and(
          eq(systemIntelEventsTable.corporationId, monitor.corporationId),
          eq(systemIntelEventsTable.monitorId, monitor.id),
          eq(systemIntelEventsTable.source, "killmail"),
          gte(systemIntelEventsTable.occurredAt, windowStart),
        ),
      );
    const count = recentKills.length;
    if (count >= monitor.burstThreshold) {
      const burstParticipantCount = countUniquePlayerParticipants(
        recentKills.map((event) => event.metadata),
      );
      const burstTtlMinutes = calculateDynamicIntelTtlMinutes({
        killCount: count,
        participantCount: burstParticipantCount,
      });
      const bucket = Math.floor(
        occurredAt.getTime() / (monitor.burstWindowMinutes * 60 * 1_000),
      );
      const burstSummary = `${monitor.solarSystemName} 在 ${monitor.burstWindowMinutes} 分钟内出现 ${count} 条玩家击杀`;
      const burstExpiresAt = intelExpiresAt(occurredAt, burstTtlMinutes);
      const burstMetadata = {
        playerKillCount: count,
        playerParticipantCount: burstParticipantCount,
      };
      await db
        .insert(systemIntelEventsTable)
        .values({
          corporationId: monitor.corporationId,
          monitorId: monitor.id,
          source: "activity",
          eventType: "kill_burst",
          severity: "danger",
          confidence: "confirmed",
          solarSystemId: monitor.solarSystemId,
          solarSystemName: monitor.solarSystemName,
          summary: burstSummary,
          metadata: burstMetadata,
          occurredAt,
          expiresAt: burstExpiresAt,
          dedupeKey: intelDedupeKey(["kill-burst", monitor.id, bucket]),
        })
        .onConflictDoUpdate({
          target: [
            systemIntelEventsTable.corporationId,
            systemIntelEventsTable.dedupeKey,
          ],
          set: {
            summary: burstSummary,
            enemyCount: null,
            metadata: burstMetadata,
            occurredAt,
            expiresAt: sql`GREATEST(${systemIntelEventsTable.expiresAt}, ${burstExpiresAt})`,
          },
        });
    }
  }
}

let killmailSweepRunning = false;
export async function runKillmailSweep() {
  if (killmailSweepRunning) return;
  killmailSweepRunning = true;
  const lockClient = await pool.connect().catch(() => null);
  let hasLock = false;
  try {
    if (!lockClient) return;
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [20260905, 1],
    );
    hasLock = Boolean(lockResult.rows[0]?.locked);
    if (!hasLock) return;
    let [state] = await db
      .select()
      .from(systemMonitorFeedStateTable)
      .where(eq(systemMonitorFeedStateTable.feed, "r2z2"));
    if (!state) {
      const pointerResponse = await externalJson(R2Z2_SEQUENCE_URL);
      if (!pointerResponse.ok)
        throw new Error(`R2Z2 pointer returned ${pointerResponse.status}`);
      const pointer = (await pointerResponse.json()) as { sequence?: number };
      if (!Number.isInteger(pointer.sequence))
        throw new Error("R2Z2 pointer is invalid");
      [state] = await db
        .insert(systemMonitorFeedStateTable)
        .values({
          feed: "r2z2",
          nextSequence: pointer.sequence!,
        })
        .onConflictDoUpdate({
          target: systemMonitorFeedStateTable.feed,
          set: { updatedAt: new Date() },
        })
        .returning();
    }

    let nextSequence = Number(state.nextSequence);
    let processed = 0;
    while (processed < MAX_SEQUENCES_PER_SWEEP) {
      const response = await externalJson(
        `https://r2z2.zkillboard.com/ephemeral/${nextSequence}.json`,
      );
      if (response.status === 404) {
        if (processed === 0) {
          const pointerResponse = await externalJson(R2Z2_SEQUENCE_URL);
          if (pointerResponse.ok) {
            const pointer = (await pointerResponse.json()) as {
              sequence?: number;
            };
            if (
              Number.isInteger(pointer.sequence) &&
              pointer.sequence! - nextSequence > 500
            ) {
              nextSequence = pointer.sequence!;
            }
          }
        }
        break;
      }
      if (!response.ok)
        throw new Error(
          `R2Z2 sequence ${nextSequence} returned ${response.status}`,
        );
      const killmail = extractR2Z2Killmail(await response.json());
      if (killmail) await processKillmail(killmail);
      nextSequence += 1;
      processed += 1;
      await new Promise((resolve) =>
        setTimeout(resolve, R2Z2_SEQUENCE_FETCH_DELAY_MS),
      );
    }
    if (nextSequence !== Number(state.nextSequence)) {
      await db
        .update(systemMonitorFeedStateTable)
        .set({
          nextSequence,
          updatedAt: new Date(),
        })
        .where(eq(systemMonitorFeedStateTable.feed, "r2z2"));
    }
  } catch (error) {
    logger.warn({ err: error }, "System monitoring killmail sweep failed");
  } finally {
    if (lockClient) {
      if (hasLock)
        await lockClient
          .query(
            "SELECT pg_advisory_unlock($1::integer, $2::integer)",
            [20260905, 1],
          )
          .catch(() => undefined);
      lockClient.release();
    }
    killmailSweepRunning = false;
  }
}

type SystemJumps = { system_id: number; ship_jumps: number };
type SystemKills = {
  system_id: number;
  npc_kills: number;
  pod_kills: number;
  ship_kills: number;
};

let activitySweepRunning = false;
export async function runSystemActivitySweep() {
  if (activitySweepRunning) return;
  activitySweepRunning = true;
  const lockClient = await pool.connect().catch(() => null);
  let hasLock = false;
  try {
    if (!lockClient) return;
    const lockResult = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [20260905, 2],
    );
    hasLock = Boolean(lockResult.rows[0]?.locked);
    if (!hasLock) return;
    await cleanupExpiredPairings();
    const monitorRows = await db
      .select({ monitor: monitoredSystemsTable })
      .from(monitoredSystemsTable)
      .innerJoin(
        corporationsTable,
        and(
          eq(corporationsTable.id, monitoredSystemsTable.corporationId),
          eq(corporationsTable.isActive, true),
          eq(corporationsTable.fleetEnabled, true),
        ),
      )
      .where(eq(monitoredSystemsTable.isActive, true));
    const monitors = monitorRows.map((row) => row.monitor);
    if (monitors.length === 0) return;
    const [jumpsResponse, killsResponse] = await Promise.all([
      externalJson(
        "https://esi.evetech.net/universe/system_jumps/?datasource=tranquility",
      ),
      externalJson(
        "https://esi.evetech.net/universe/system_kills/?datasource=tranquility",
      ),
    ]);
    if (!jumpsResponse.ok || !killsResponse.ok) {
      throw new Error(
        `ESI activity returned jumps=${jumpsResponse.status}, kills=${killsResponse.status}`,
      );
    }
    const jumps = new Map(
      ((await jumpsResponse.json()) as SystemJumps[]).map((row) => [
        row.system_id,
        row.ship_jumps,
      ]),
    );
    const kills = new Map(
      ((await killsResponse.json()) as SystemKills[]).map((row) => [
        row.system_id,
        row,
      ]),
    );
    const sampledAt = new Date();
    sampledAt.setUTCMinutes(0, 0, 0);

    for (const monitor of monitors) {
      const prior = await db
        .select()
        .from(systemActivitySamplesTable)
        .where(
          and(
            eq(systemActivitySamplesTable.corporationId, monitor.corporationId),
            eq(systemActivitySamplesTable.monitorId, monitor.id),
          ),
        )
        .orderBy(desc(systemActivitySamplesTable.sampledAt))
        .limit(24);
      const jumpBaseline =
        prior.length >= 6
          ? prior.reduce((total, row) => total + row.jumps, 0) / prior.length
          : null;
      const killBaseline =
        prior.length >= 6
          ? prior.reduce((total, row) => total + countPlayerKills(row), 0) /
            prior.length
          : null;
      const currentJumps = jumps.get(monitor.solarSystemId) ?? 0;
      const currentKills = kills.get(monitor.solarSystemId) ?? {
        npc_kills: 0,
        pod_kills: 0,
        ship_kills: 0,
      };
      const currentPlayerKills = countPlayerKills({
        shipKills: currentKills.ship_kills,
        podKills: currentKills.pod_kills,
        npcKills: currentKills.npc_kills,
      });
      const isAnomalous =
        jumpBaseline !== null &&
        killBaseline !== null &&
        currentJumps >=
          Math.max(10, jumpBaseline * Number(monitor.activityMultiplier)) &&
        currentPlayerKills >=
          Math.max(2, killBaseline * Number(monitor.activityMultiplier));

      await db
        .insert(systemActivitySamplesTable)
        .values({
          corporationId: monitor.corporationId,
          monitorId: monitor.id,
          solarSystemId: monitor.solarSystemId,
          sampledAt,
          jumps: currentJumps,
          shipKills: currentKills.ship_kills,
          podKills: currentKills.pod_kills,
          npcKills: currentKills.npc_kills,
          jumpBaseline,
          killBaseline,
          isAnomalous,
        })
        .onConflictDoUpdate({
          target: [
            systemActivitySamplesTable.monitorId,
            systemActivitySamplesTable.sampledAt,
          ],
          set: {
            jumps: currentJumps,
            shipKills: currentKills.ship_kills,
            podKills: currentKills.pod_kills,
            npcKills: currentKills.npc_kills,
            jumpBaseline,
            killBaseline,
            isAnomalous,
          },
        });
      if (isAnomalous) {
        const detectedAt = new Date();
        const activityTtlMinutes = calculateDynamicIntelTtlMinutes({
          killCount: currentPlayerKills,
        });
        await db
          .insert(systemIntelEventsTable)
          .values({
            corporationId: monitor.corporationId,
            monitorId: monitor.id,
            source: "activity",
            eventType: "activity_spike",
            severity: "danger",
            confidence: "confirmed",
            solarSystemId: monitor.solarSystemId,
            solarSystemName: monitor.solarSystemName,
            summary: `${monitor.solarSystemName} 的玩家击杀和跳跃活动同时高于近期基线`,
            occurredAt: detectedAt,
            expiresAt: intelExpiresAt(detectedAt, activityTtlMinutes),
            dedupeKey: intelDedupeKey([
              "activity-spike",
              monitor.id,
              sampledAt.toISOString(),
            ]),
          })
          .onConflictDoNothing();
      }
    }
  } catch (error) {
    logger.warn({ err: error }, "System monitoring activity sweep failed");
  } finally {
    if (lockClient) {
      if (hasLock)
        await lockClient
          .query(
            "SELECT pg_advisory_unlock($1::integer, $2::integer)",
            [20260905, 2],
          )
          .catch(() => undefined);
      lockClient.release();
    }
    activitySweepRunning = false;
  }
}

export function startSystemMonitoringJobs() {
  void runKillmailSweep();
  void runSystemActivitySweep();
  const killmailTimer = setInterval(
    () => void runKillmailSweep(),
    R2Z2_POLL_INTERVAL_MS,
  );
  const activityTimer = setInterval(
    () => void runSystemActivitySweep(),
    ACTIVITY_SYNC_INTERVAL_MS,
  );
  killmailTimer.unref();
  activityTimer.unref();
}
