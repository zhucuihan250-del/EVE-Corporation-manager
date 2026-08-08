import {
  charactersTable,
  corporationRosterConnectionsTable,
  db,
  usersTable,
} from "@workspace/db";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { refreshAccessToken } from "./eve-sso";

const ESI_BASE = "https://esi.evetech.net/latest";
const ESI_COMPATIBILITY_DATE = "2026-07-20";
const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_WINDOW_DAYS = 60;
const USER_AGENT = process.env.EVE_ESI_USER_AGENT
  || `EVE-PAP-Tracker/1.0 (+${process.env.FRONTEND_URL || "https://zephyr-fleet-track-production.up.railway.app"})`;

type MemberTrackingEntry = {
  character_id: number;
  start_date?: string;
};

type ResolvedName = {
  id: number;
  name: string;
  category: string;
};

export type RecentUnboundMember = {
  characterId: number;
  characterName: string;
  corporationJoinedAt: Date;
  daysInCorporation: number;
};

function connectionSummary(connection: typeof corporationRosterConnectionsTable.$inferSelect | null) {
  if (!connection) return null;
  return {
    characterId: connection.characterId,
    status: connection.status,
    lastError: connection.lastError,
    lastSyncedAt: connection.lastSyncedAt,
  };
}

async function getConnection(corporationId: number) {
  const [connection] = await db
    .select()
    .from(corporationRosterConnectionsTable)
    .where(eq(corporationRosterConnectionsTable.corporationId, corporationId));
  return connection ?? null;
}

async function authorizedRosterToken(corporationId: number): Promise<string> {
  const connection = await getConnection(corporationId);
  if (!connection) throw new Error("CORPORATION_ROSTER_NOT_CONNECTED");
  if (connection.tokenExpiry.getTime() > Date.now() + 60_000) return connection.accessToken;

  try {
    const refreshed = await refreshAccessToken(connection.refreshToken);
    await db.update(corporationRosterConnectionsTable).set({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      tokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1_000),
      status: "connected",
      lastError: null,
    }).where(eq(corporationRosterConnectionsTable.corporationId, corporationId));
    return refreshed.accessToken;
  } catch (error) {
    await markConnectionError(corporationId, error, "EVE SSO token refresh failed");
    throw error;
  }
}

async function markConnectionError(corporationId: number, error: unknown, fallback: string): Promise<void> {
  await db.update(corporationRosterConnectionsTable).set({
    status: "error",
    lastError: (error instanceof Error ? error.message : fallback).slice(0, 1_000),
  }).where(eq(corporationRosterConnectionsTable.corporationId, corporationId));
}

async function fetchMemberTracking(corporationId: number, accessToken: string): Promise<MemberTrackingEntry[]> {
  const response = await fetch(
    `${ESI_BASE}/corporations/${corporationId}/membertracking/?datasource=tranquility`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        "X-Compatibility-Date": ESI_COMPATIBILITY_DATE,
      },
      signal: AbortSignal.timeout(20_000),
    },
  );
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    if (response.status === 403) {
      throw new Error("EVE总监授权无权读取成员追踪，请使用拥有Director角色的当前军团角色重新授权");
    }
    throw new Error(`EVE成员追踪读取失败（${response.status}）${body ? `：${body}` : ""}`);
  }
  return (await response.json()) as MemberTrackingEntry[];
}

async function resolveCharacterNames(characterIds: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  for (let offset = 0; offset < characterIds.length; offset += 1_000) {
    const ids = characterIds.slice(offset, offset + 1_000);
    const response = await fetch(`${ESI_BASE}/universe/names/?datasource=tranquility`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "X-Compatibility-Date": ESI_COMPATIBILITY_DATE,
      },
      body: JSON.stringify(ids),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`EVE角色名称读取失败（${response.status}）`);
    const payload = (await response.json()) as ResolvedName[];
    for (const item of payload) {
      if (item.category === "character") names.set(item.id, item.name);
    }
  }
  return names;
}

export async function getRecentUnboundMemberAudit(
  corporationId: number,
  now = new Date(),
  windowDays = DEFAULT_WINDOW_DAYS,
) {
  const existingConnection = await getConnection(corporationId);
  if (!existingConnection) {
    return {
      connection: null,
      reviewedAt: null,
      windowDays,
      totalCorporationMembers: null,
      recentMemberCount: 0,
      unboundMemberCount: 0,
      members: [] as RecentUnboundMember[],
    };
  }

  const accessToken = await authorizedRosterToken(corporationId);
  try {
    const tracking = await fetchMemberTracking(corporationId, accessToken);
    const [boundCharacters, boundMainCharacters] = await Promise.all([
      db.select({ characterId: charactersTable.eveCharacterId })
        .from(charactersTable)
        .where(and(
          eq(charactersTable.corporationId, corporationId),
          isNull(charactersTable.deletedAt),
        )),
      db.select({ characterId: usersTable.eveCharacterId })
        .from(usersTable)
        .where(and(
          eq(usersTable.corporationId, corporationId),
          isNotNull(usersTable.eveCharacterId),
        )),
    ]);
    const boundIds = new Set<number>([
      ...boundCharacters.map((item) => item.characterId),
      ...boundMainCharacters.flatMap((item) => item.characterId === null ? [] : [item.characterId]),
    ]);
    const cutoff = now.getTime() - windowDays * DAY_MS;
    const recentMembers = tracking.flatMap((member) => {
      if (!Number.isInteger(member.character_id) || !member.start_date) return [];
      const corporationJoinedAt = new Date(member.start_date);
      const joinedAt = corporationJoinedAt.getTime();
      if (!Number.isFinite(joinedAt) || joinedAt < cutoff || joinedAt > now.getTime()) return [];
      return [{ characterId: member.character_id, corporationJoinedAt }];
    });
    const unboundMembers = recentMembers.filter((member) => !boundIds.has(member.characterId));
    const names = await resolveCharacterNames(unboundMembers.map((member) => member.characterId));
    const members = unboundMembers.map((member) => ({
      ...member,
      characterName: names.get(member.characterId) ?? `Character ${member.characterId}`,
      daysInCorporation: Math.max(0, Math.floor((now.getTime() - member.corporationJoinedAt.getTime()) / DAY_MS)),
    })).sort((left, right) => (
      right.corporationJoinedAt.getTime() - left.corporationJoinedAt.getTime()
      || left.characterName.localeCompare(right.characterName)
    ));

    await db.update(corporationRosterConnectionsTable).set({
      status: "connected",
      lastError: null,
      lastSyncedAt: now,
    }).where(eq(corporationRosterConnectionsTable.corporationId, corporationId));

    return {
      connection: {
        characterId: existingConnection.characterId,
        status: "connected" as const,
        lastError: null,
        lastSyncedAt: now,
      },
      reviewedAt: now,
      windowDays,
      totalCorporationMembers: tracking.length,
      recentMemberCount: recentMembers.length,
      unboundMemberCount: members.length,
      members,
    };
  } catch (error) {
    await markConnectionError(corporationId, error, "Corporation roster audit failed");
    throw error;
  }
}

export async function getCorporationRosterConnection(corporationId: number) {
  return connectionSummary(await getConnection(corporationId));
}
