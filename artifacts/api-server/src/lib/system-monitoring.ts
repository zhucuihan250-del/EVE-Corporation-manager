import { createHash, randomBytes } from "node:crypto";
import {
  charactersTable,
  corporationsTable,
  db,
  intelBridgePairingsTable,
  intelBridgesTable,
  monitoredSystemsTable,
  systemActivitySamplesTable,
  systemIntelEventsTable,
  usersTable,
} from "@workspace/db";
import { and, desc, eq, gte, isNull, lt } from "drizzle-orm";
import {
  highestSeverity,
  intelDedupeKey,
  parseIntelMessage,
} from "./system-monitoring-rules";

const PAIRING_LIFETIME_MS = 10 * 60 * 1_000;
const BRIDGE_ONLINE_WINDOW_MS = 90 * 1_000;
const DASHBOARD_HISTORY_MS = 24 * 60 * 60 * 1_000;
const MAX_CHAT_EVENT_AGE_MS = 60 * 60 * 1_000;

export type BridgeAuth = {
  bridge: typeof intelBridgesTable.$inferSelect;
  corporation: typeof corporationsTable.$inferSelect;
};

export type IncomingChatEvent = {
  channelName: string;
  reporterCharacterName: string;
  message: string;
  occurredAt: string;
};

function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeChannels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.flatMap((item) => {
        if (typeof item !== "string") return [];
        const channel = item.trim().slice(0, 120);
        return channel ? [channel] : [];
      }),
    ),
  ].slice(0, 20);
}

function formatMonitor(monitor: typeof monitoredSystemsTable.$inferSelect) {
  return {
    ...monitor,
    highValueThreshold: Number(monitor.highValueThreshold),
    activityMultiplier: Number(monitor.activityMultiplier),
  };
}

export async function resolveSolarSystemName(name: string): Promise<{
  id: number;
  name: string;
}> {
  const requestedName = name.trim();
  if (requestedName.length < 2 || requestedName.length > 100) {
    throw new Error("请输入完整的星系名称");
  }
  const response = await fetch(
    "https://esi.evetech.net/universe/ids/?datasource=tranquility&language=en",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "EVE-Corporation-manager/system-monitoring",
      },
      body: JSON.stringify([requestedName]),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok)
    throw new Error(`EVE ESI 无法验证该星系（${response.status}）`);
  const payload = (await response.json()) as {
    systems?: Array<{ id?: number; name?: string }>;
  };
  const system = payload.systems?.find(
    (candidate) =>
      typeof candidate.id === "number" &&
      typeof candidate.name === "string" &&
      candidate.name.localeCompare(requestedName, undefined, {
        sensitivity: "accent",
      }) === 0,
  );
  if (!system?.id || !system.name)
    throw new Error("没有找到该星系，请使用游戏内完整名称");
  return { id: system.id, name: system.name };
}

export async function loadSystemMonitoringDashboard(corporationId: number) {
  const now = new Date();
  const historyStart = new Date(now.getTime() - DASHBOARD_HISTORY_MS);
  const [monitors, events, samples, bridges] = await Promise.all([
    db
      .select()
      .from(monitoredSystemsTable)
      .where(
        and(
          eq(monitoredSystemsTable.corporationId, corporationId),
          eq(monitoredSystemsTable.isActive, true),
        ),
      )
      .orderBy(monitoredSystemsTable.solarSystemName),
    db
      .select()
      .from(systemIntelEventsTable)
      .where(
        and(
          eq(systemIntelEventsTable.corporationId, corporationId),
          gte(systemIntelEventsTable.occurredAt, historyStart),
        ),
      )
      .orderBy(desc(systemIntelEventsTable.occurredAt))
      .limit(300),
    db
      .select()
      .from(systemActivitySamplesTable)
      .where(
        and(
          eq(systemActivitySamplesTable.corporationId, corporationId),
          gte(systemActivitySamplesTable.sampledAt, historyStart),
        ),
      )
      .orderBy(desc(systemActivitySamplesTable.sampledAt)),
    db
      .select({
        id: intelBridgesTable.id,
        isActive: intelBridgesTable.isActive,
        lastSeenAt: intelBridgesTable.lastSeenAt,
      })
      .from(intelBridgesTable)
      .where(eq(intelBridgesTable.corporationId, corporationId)),
  ]);

  const activeEvents = events.filter(
    (event) =>
      event.expiresAt === null || event.expiresAt.getTime() > now.getTime(),
  );
  const latestSampleByMonitor = new Map<number, (typeof samples)[number]>();
  for (const sample of samples) {
    if (!latestSampleByMonitor.has(sample.monitorId))
      latestSampleByMonitor.set(sample.monitorId, sample);
  }

  const monitorSummaries = monitors.map((monitor) => {
    const windowStart = now.getTime() - monitor.burstWindowMinutes * 60 * 1_000;
    const currentEvents = activeEvents.filter(
      (event) => event.monitorId === monitor.id,
    );
    const recentKills = events.filter(
      (event) =>
        event.monitorId === monitor.id &&
        event.source === "killmail" &&
        event.occurredAt.getTime() >= windowStart,
    );
    const risk =
      recentKills.length >= monitor.burstThreshold
        ? highestSeverity([
            ...currentEvents.map((event) => event.severity),
            "danger",
          ])
        : highestSeverity(currentEvents.map((event) => event.severity));
    return {
      ...formatMonitor(monitor),
      risk,
      activeEventCount: currentEvents.length,
      recentKillCount: recentKills.length,
      lastEventAt:
        events.find((event) => event.monitorId === monitor.id)?.occurredAt ??
        null,
      latestActivity: latestSampleByMonitor.get(monitor.id) ?? null,
    };
  });

  const onlineCutoff = now.getTime() - BRIDGE_ONLINE_WINDOW_MS;
  return {
    generatedAt: now,
    monitors: monitorSummaries,
    events,
    bridgeStatus: {
      total: bridges.filter((bridge) => bridge.isActive).length,
      online: bridges.filter(
        (bridge) =>
          bridge.isActive &&
          bridge.lastSeenAt &&
          bridge.lastSeenAt.getTime() >= onlineCutoff,
      ).length,
    },
  };
}

export async function listMonitoredSystems(corporationId: number) {
  return (
    await db
      .select()
      .from(monitoredSystemsTable)
      .where(eq(monitoredSystemsTable.corporationId, corporationId))
      .orderBy(monitoredSystemsTable.solarSystemName)
  ).map(formatMonitor);
}

export async function createMonitoredSystem(input: {
  corporationId: number;
  createdBy: number;
  solarSystemName: string;
  burstWindowMinutes: number;
  burstThreshold: number;
  highValueThreshold: number;
  activityMultiplier: number;
  notes?: string | null;
}) {
  const system = await resolveSolarSystemName(input.solarSystemName);
  const [existing] = await db
    .select()
    .from(monitoredSystemsTable)
    .where(
      and(
        eq(monitoredSystemsTable.corporationId, input.corporationId),
        eq(monitoredSystemsTable.solarSystemId, system.id),
      ),
    );
  if (existing) {
    const [updated] = await db
      .update(monitoredSystemsTable)
      .set({
        solarSystemName: system.name,
        isActive: true,
        burstWindowMinutes: input.burstWindowMinutes,
        burstThreshold: input.burstThreshold,
        highValueThreshold: input.highValueThreshold,
        activityMultiplier: input.activityMultiplier,
        notes: input.notes ?? null,
      })
      .where(
        and(
          eq(monitoredSystemsTable.corporationId, input.corporationId),
          eq(monitoredSystemsTable.id, existing.id),
        ),
      )
      .returning();
    return formatMonitor(updated);
  }
  const [created] = await db
    .insert(monitoredSystemsTable)
    .values({
      corporationId: input.corporationId,
      createdBy: input.createdBy,
      solarSystemId: system.id,
      solarSystemName: system.name,
      burstWindowMinutes: input.burstWindowMinutes,
      burstThreshold: input.burstThreshold,
      highValueThreshold: input.highValueThreshold,
      activityMultiplier: input.activityMultiplier,
      notes: input.notes ?? null,
    })
    .returning();
  return formatMonitor(created);
}

export async function createBridgePairing(
  corporationId: number,
  createdBy: number,
) {
  const code = randomBytes(12).toString("base64url").toLocaleUpperCase();
  const expiresAt = new Date(Date.now() + PAIRING_LIFETIME_MS);
  await db.insert(intelBridgePairingsTable).values({
    corporationId,
    createdBy,
    codeHash: hashSecret(code),
    expiresAt,
  });
  return { code, expiresAt };
}

export async function pairBridge(input: {
  code: string;
  name: string;
  platform?: string | null;
  channelNames?: unknown;
}) {
  return db.transaction(async (tx) => {
    const [pairing] = await tx
      .select()
      .from(intelBridgePairingsTable)
      .where(
        eq(
          intelBridgePairingsTable.codeHash,
          hashSecret(input.code.trim().toLocaleUpperCase()),
        ),
      )
      .for("update");
    if (
      !pairing ||
      pairing.usedAt ||
      pairing.expiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    const token = `eib_${randomBytes(32).toString("base64url")}`;
    const [bridge] = await tx
      .insert(intelBridgesTable)
      .values({
        corporationId: pairing.corporationId,
        ownerUserId: pairing.createdBy,
        name: input.name.trim().slice(0, 120),
        devicePlatform: input.platform?.trim().slice(0, 120) || null,
        tokenHash: hashSecret(token),
        channelNames: normalizeChannels(input.channelNames),
        lastSeenAt: new Date(),
      })
      .returning();
    await tx
      .update(intelBridgePairingsTable)
      .set({ usedAt: new Date() })
      .where(eq(intelBridgePairingsTable.id, pairing.id));
    return { bridge, token };
  });
}

export async function authenticateBridge(
  authorization: string | undefined,
): Promise<BridgeAuth | null> {
  if (!authorization?.startsWith("Bearer eib_")) return null;
  const token = authorization.slice("Bearer ".length).trim();
  const [row] = await db
    .select({ bridge: intelBridgesTable, corporation: corporationsTable })
    .from(intelBridgesTable)
    .innerJoin(
      corporationsTable,
      eq(corporationsTable.id, intelBridgesTable.corporationId),
    )
    .where(
      and(
        eq(intelBridgesTable.tokenHash, hashSecret(token)),
        eq(intelBridgesTable.isActive, true),
        eq(corporationsTable.isActive, true),
        eq(corporationsTable.fleetEnabled, true),
      ),
    );
  return row ?? null;
}

export async function listIntelBridges(corporationId: number) {
  return db
    .select({
      id: intelBridgesTable.id,
      name: intelBridgesTable.name,
      devicePlatform: intelBridgesTable.devicePlatform,
      channelNames: intelBridgesTable.channelNames,
      isActive: intelBridgesTable.isActive,
      lastSeenAt: intelBridgesTable.lastSeenAt,
      lastError: intelBridgesTable.lastError,
      createdAt: intelBridgesTable.createdAt,
      ownerUserId: intelBridgesTable.ownerUserId,
      ownerName: usersTable.eveCharacterName,
    })
    .from(intelBridgesTable)
    .leftJoin(usersTable, eq(usersTable.id, intelBridgesTable.ownerUserId))
    .where(eq(intelBridgesTable.corporationId, corporationId))
    .orderBy(desc(intelBridgesTable.createdAt));
}

export async function updateBridge(
  corporationId: number,
  bridgeId: number,
  input: {
    name?: string;
    channelNames?: unknown;
    isActive?: boolean;
  },
) {
  const changes: Partial<typeof intelBridgesTable.$inferInsert> = {};
  if (input.name !== undefined) changes.name = input.name.trim().slice(0, 120);
  if (input.channelNames !== undefined)
    changes.channelNames = normalizeChannels(input.channelNames);
  if (input.isActive !== undefined) changes.isActive = input.isActive;
  const [updated] = await db
    .update(intelBridgesTable)
    .set(changes)
    .where(
      and(
        eq(intelBridgesTable.corporationId, corporationId),
        eq(intelBridgesTable.id, bridgeId),
      ),
    )
    .returning();
  return updated ?? null;
}

export async function updateBridgeHeartbeat(
  auth: BridgeAuth,
  lastError?: string | null,
) {
  const [bridge] = await db
    .update(intelBridgesTable)
    .set({
      lastSeenAt: new Date(),
      lastError: lastError?.trim().slice(0, 1_000) || null,
    })
    .where(
      and(
        eq(intelBridgesTable.corporationId, auth.corporation.id),
        eq(intelBridgesTable.id, auth.bridge.id),
        eq(intelBridgesTable.isActive, true),
      ),
    )
    .returning();
  return bridge ?? null;
}

export async function bridgeConfig(auth: BridgeAuth) {
  const monitors = await db
    .select({
      id: monitoredSystemsTable.id,
      solarSystemId: monitoredSystemsTable.solarSystemId,
      solarSystemName: monitoredSystemsTable.solarSystemName,
    })
    .from(monitoredSystemsTable)
    .where(
      and(
        eq(monitoredSystemsTable.corporationId, auth.corporation.id),
        eq(monitoredSystemsTable.isActive, true),
      ),
    );
  return {
    bridgeId: auth.bridge.id,
    corporationId: auth.corporation.id,
    corporationName: auth.corporation.name,
    channelNames: auth.bridge.channelNames,
    monitoredSystems: monitors,
  };
}

function validIncomingChatEvent(value: IncomingChatEvent): boolean {
  return (
    typeof value.channelName === "string" &&
    value.channelName.trim().length > 0 &&
    value.channelName.length <= 120 &&
    typeof value.reporterCharacterName === "string" &&
    value.reporterCharacterName.trim().length > 0 &&
    value.reporterCharacterName.length <= 120 &&
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    value.message.length <= 2_000 &&
    typeof value.occurredAt === "string"
  );
}

export async function ingestBridgeEvents(
  auth: BridgeAuth,
  incoming: IncomingChatEvent[],
) {
  const monitors = await db
    .select({
      id: monitoredSystemsTable.id,
      solarSystemId: monitoredSystemsTable.solarSystemId,
      solarSystemName: monitoredSystemsTable.solarSystemName,
    })
    .from(monitoredSystemsTable)
    .where(
      and(
        eq(monitoredSystemsTable.corporationId, auth.corporation.id),
        eq(monitoredSystemsTable.isActive, true),
      ),
    );
  const allowedChannels = new Set(
    auth.bridge.channelNames.map((channel) => channel.toLocaleLowerCase()),
  );
  let accepted = 0;
  let duplicates = 0;
  let ignored = 0;

  for (const item of incoming.slice(0, 100)) {
    if (!validIncomingChatEvent(item)) {
      ignored += 1;
      continue;
    }
    const occurredAt = new Date(item.occurredAt);
    if (
      Number.isNaN(occurredAt.getTime()) ||
      occurredAt.getTime() < Date.now() - MAX_CHAT_EVENT_AGE_MS ||
      occurredAt.getTime() > Date.now() + 5 * 60 * 1_000 ||
      (allowedChannels.size > 0 &&
        !allowedChannels.has(item.channelName.trim().toLocaleLowerCase()))
    ) {
      ignored += 1;
      continue;
    }
    const parsed = parseIntelMessage(item.message, [...monitors]);
    if (!parsed) {
      ignored += 1;
      continue;
    }
    const reporterName = item.reporterCharacterName.trim();
    const [reporter] = await db
      .select({ userId: charactersTable.userId })
      .from(charactersTable)
      .where(
        and(
          eq(charactersTable.corporationId, auth.corporation.id),
          eq(charactersTable.eveCharacterName, reporterName),
          isNull(charactersTable.deletedAt),
        ),
      )
      .limit(1);
    const dedupeKey = intelDedupeKey([
      "chat",
      item.channelName,
      reporterName,
      occurredAt.toISOString(),
      item.message,
    ]);
    const [created] = await db
      .insert(systemIntelEventsTable)
      .values({
        corporationId: auth.corporation.id,
        monitorId: parsed.monitor.id,
        relayBridgeId: auth.bridge.id,
        reporterUserId: reporter?.userId ?? null,
        reporterCharacterName: reporterName,
        source: "chat",
        eventType: "hostile_report",
        severity: parsed.severity,
        confidence: reporter?.userId ? "reported" : "unconfirmed",
        solarSystemId: parsed.monitor.solarSystemId,
        solarSystemName: parsed.monitor.solarSystemName,
        summary: `${reporterName} 报告：${item.message.trim().slice(0, 500)}`,
        rawMessage: item.message.trim(),
        enemyCount: parsed.enemyCount,
        shipTags: parsed.shipTags,
        direction: parsed.direction,
        metadata: { channelName: item.channelName.trim(), relayCount: 1 },
        occurredAt,
        expiresAt: new Date(
          occurredAt.getTime() + parsed.ttlMinutes * 60 * 1_000,
        ),
        dedupeKey,
      })
      .onConflictDoNothing()
      .returning({ id: systemIntelEventsTable.id });
    if (created) accepted += 1;
    else duplicates += 1;
  }

  await updateBridgeHeartbeat(auth);
  return { accepted, duplicates, ignored };
}

export async function createManualIntelReport(input: {
  corporationId: number;
  userId: number;
  reporterCharacterName: string;
  monitorId: number;
  enemyCount?: number | null;
  shipTags?: string[];
  direction?: string | null;
  message: string;
  ttlMinutes: number;
}) {
  const [monitor] = await db
    .select()
    .from(monitoredSystemsTable)
    .where(
      and(
        eq(monitoredSystemsTable.corporationId, input.corporationId),
        eq(monitoredSystemsTable.id, input.monitorId),
        eq(monitoredSystemsTable.isActive, true),
      ),
    );
  if (!monitor) return null;
  const occurredAt = new Date();
  const parsed = parseIntelMessage(
    `${monitor.solarSystemName} +${input.enemyCount ?? ""} ${(input.shipTags ?? []).join(" ")} ${input.message}`,
    [
      {
        id: monitor.id,
        solarSystemId: monitor.solarSystemId,
        solarSystemName: monitor.solarSystemName,
      },
    ],
  );
  const dedupeKey = intelDedupeKey([
    "manual",
    input.corporationId,
    input.userId,
    monitor.id,
    Math.floor(occurredAt.getTime() / 30_000),
    input.message,
  ]);
  const [created] = await db
    .insert(systemIntelEventsTable)
    .values({
      corporationId: input.corporationId,
      monitorId: monitor.id,
      reporterUserId: input.userId,
      reporterCharacterName: input.reporterCharacterName,
      source: "manual",
      eventType: "hostile_report",
      severity: parsed?.severity ?? "warning",
      confidence: "reported",
      solarSystemId: monitor.solarSystemId,
      solarSystemName: monitor.solarSystemName,
      summary: `${input.reporterCharacterName} 报告：${input.message.trim().slice(0, 500)}`,
      rawMessage: input.message.trim(),
      enemyCount: input.enemyCount ?? null,
      shipTags: (input.shipTags ?? []).slice(0, 20),
      direction: input.direction?.trim().slice(0, 120) || null,
      occurredAt,
      expiresAt: new Date(
        occurredAt.getTime() +
          Math.min(60, Math.max(5, input.ttlMinutes)) * 60 * 1_000,
      ),
      dedupeKey,
    })
    .onConflictDoNothing()
    .returning();
  return created ?? null;
}

export async function setMonitorActive(
  corporationId: number,
  monitorId: number,
  isActive: boolean,
) {
  const [updated] = await db
    .update(monitoredSystemsTable)
    .set({ isActive })
    .where(
      and(
        eq(monitoredSystemsTable.corporationId, corporationId),
        eq(monitoredSystemsTable.id, monitorId),
      ),
    )
    .returning();
  return updated ? formatMonitor(updated) : null;
}

export async function updateMonitoredSystem(
  corporationId: number,
  monitorId: number,
  input: {
    isActive?: boolean;
    burstWindowMinutes?: number;
    burstThreshold?: number;
    highValueThreshold?: number;
    activityMultiplier?: number;
    notes?: string | null;
  },
) {
  const changes: Partial<typeof monitoredSystemsTable.$inferInsert> = {};
  if (input.isActive !== undefined) changes.isActive = input.isActive;
  if (input.burstWindowMinutes !== undefined)
    changes.burstWindowMinutes = input.burstWindowMinutes;
  if (input.burstThreshold !== undefined)
    changes.burstThreshold = input.burstThreshold;
  if (input.highValueThreshold !== undefined)
    changes.highValueThreshold = input.highValueThreshold;
  if (input.activityMultiplier !== undefined)
    changes.activityMultiplier = input.activityMultiplier;
  if (input.notes !== undefined)
    changes.notes = input.notes?.trim().slice(0, 2_000) || null;
  const [updated] = await db
    .update(monitoredSystemsTable)
    .set(changes)
    .where(
      and(
        eq(monitoredSystemsTable.corporationId, corporationId),
        eq(monitoredSystemsTable.id, monitorId),
      ),
    )
    .returning();
  return updated ? formatMonitor(updated) : null;
}

export async function cleanupExpiredPairings() {
  await db
    .delete(intelBridgePairingsTable)
    .where(
      and(
        isNull(intelBridgePairingsTable.usedAt),
        lt(intelBridgePairingsTable.expiresAt, new Date()),
      ),
    );
}
