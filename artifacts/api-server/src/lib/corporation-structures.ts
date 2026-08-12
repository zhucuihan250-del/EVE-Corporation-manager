import {
  corporationStructureConnectionsTable,
  corporationStructuresTable,
  db,
  type CorporationStructureService,
} from "@workspace/db";
import { and, asc, eq } from "drizzle-orm";
import { refreshAccessToken } from "./eve-sso";

const ESI_BASE = "https://esi.evetech.net/latest";
const ESI_COMPATIBILITY_DATE = "2020-01-01";

type EsiCorporationStructure = {
  corporation_id: number;
  structure_id: number;
  type_id: number;
  system_id: number;
  name?: string;
  state: string;
  fuel_expires?: string;
  state_timer_start?: string;
  state_timer_end?: string;
  unanchors_at?: string;
  services?: Array<{ name: string; state: string }>;
};

function safeDate(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function publicConnection(connection: typeof corporationStructureConnectionsTable.$inferSelect | null) {
  if (!connection) return null;
  return {
    characterId: connection.characterId,
    status: connection.status,
    lastError: connection.lastError,
    lastSyncedAt: connection.lastSyncedAt,
  };
}

async function authorizedStructuresToken(corporationId: number): Promise<string> {
  const [connection] = await db
    .select()
    .from(corporationStructureConnectionsTable)
    .where(eq(corporationStructureConnectionsTable.corporationId, corporationId));
  if (!connection) throw new Error("CORPORATION_STRUCTURES_NOT_CONNECTED");

  if (connection.tokenExpiry.getTime() > Date.now() + 60_000) {
    return connection.accessToken;
  }

  try {
    const refreshed = await refreshAccessToken(connection.refreshToken);
    await db
      .update(corporationStructureConnectionsTable)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1_000),
        status: "connected",
        lastError: null,
      })
      .where(eq(corporationStructureConnectionsTable.corporationId, corporationId));
    return refreshed.accessToken;
  } catch (error) {
    await recordSyncError(corporationId, error, "建筑授权已失效，请重新授权");
    throw new Error("建筑授权已失效，请重新授权");
  }
}

async function esiFetch<T>(url: string, accessToken?: string): Promise<{ data: T; pages: number }> {
  const response = await fetch(url, {
    headers: {
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      "Accept-Language": "en",
      "X-Compatibility-Date": ESI_COMPATIBILITY_DATE,
    },
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error("建筑授权已失效，请重新授权");
    if (response.status === 403) {
      throw new Error("授权角色缺少军团建筑读取权限；请确认角色拥有 Station Manager（空间站管理员）权限后重新授权");
    }
    if (response.status === 420 || response.status === 429) {
      throw new Error("EVE ESI 当前限制了请求频率，请稍后重试");
    }
    const body = (await response.text()).slice(0, 300);
    throw new Error(`EVE ESI 建筑同步失败（${response.status}）${body ? `：${body}` : ""}`);
  }
  return {
    data: (await response.json()) as T,
    pages: Math.max(1, Number(response.headers.get("x-pages") ?? 1)),
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  limit: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]);
    }
  }));
  return results;
}

async function resolveNames(
  ids: number[],
  kind: "universe/types" | "universe/systems",
): Promise<Map<number, string>> {
  const uniqueIds = [...new Set(ids)];
  const pairs = await mapWithConcurrency(uniqueIds, 8, async (id) => {
    try {
      const result = await esiFetch<{ name: string }>(
        `${ESI_BASE}/${kind}/${id}/?datasource=tranquility&language=en`,
      );
      return [id, result.data.name] as const;
    } catch {
      return [id, ""] as const;
    }
  });
  return new Map(pairs);
}

async function recordSyncError(corporationId: number, error: unknown, fallback: string): Promise<void> {
  const message = (error instanceof Error ? error.message : fallback).slice(0, 1_000);
  await db
    .update(corporationStructureConnectionsTable)
    .set({ status: "error", lastError: message })
    .where(eq(corporationStructureConnectionsTable.corporationId, corporationId));
}

export async function syncCorporationStructures(corporationId: number): Promise<{ structures: number; syncedAt: Date }> {
  const accessToken = await authorizedStructuresToken(corporationId);
  try {
    const structures: EsiCorporationStructure[] = [];
    let page = 1;
    let pages = 1;
    while (page <= pages && page <= 100) {
      const result = await esiFetch<EsiCorporationStructure[]>(
        `${ESI_BASE}/corporations/${corporationId}/structures/?datasource=tranquility&page=${page}`,
        accessToken,
      );
      pages = result.pages;
      structures.push(...result.data);
      page += 1;
    }

    if (structures.some((structure) => structure.corporation_id !== corporationId)) {
      throw new Error("EVE ESI 返回了不属于当前军团的建筑，已拒绝写入");
    }

    const [typeNames, systemNames] = await Promise.all([
      resolveNames(structures.map((structure) => structure.type_id), "universe/types"),
      resolveNames(structures.map((structure) => structure.system_id), "universe/systems"),
    ]);
    const syncedAt = new Date();

    await db.transaction(async (tx) => {
      await tx
        .update(corporationStructuresTable)
        .set({ isActive: false })
        .where(eq(corporationStructuresTable.corporationId, corporationId));

      for (const structure of structures) {
        const services: CorporationStructureService[] = (structure.services ?? [])
          .filter((service) => ["online", "offline", "cleanup"].includes(service.state))
          .map((service) => ({
            name: service.name,
            state: service.state as CorporationStructureService["state"],
          }));
        const values = {
          corporationId,
          structureId: String(structure.structure_id),
          name: structure.name?.trim() || `Structure ${structure.structure_id}`,
          typeId: structure.type_id,
          typeName: typeNames.get(structure.type_id) || `Type ${structure.type_id}`,
          systemId: structure.system_id,
          systemName: systemNames.get(structure.system_id) || `System ${structure.system_id}`,
          state: structure.state,
          fuelExpiresAt: safeDate(structure.fuel_expires),
          stateTimerStart: safeDate(structure.state_timer_start),
          stateTimerEnd: safeDate(structure.state_timer_end),
          unanchorsAt: safeDate(structure.unanchors_at),
          services,
          isActive: true,
          lastSeenAt: syncedAt,
          updatedAt: syncedAt,
        };
        await tx
          .insert(corporationStructuresTable)
          .values(values)
          .onConflictDoUpdate({
            target: [
              corporationStructuresTable.corporationId,
              corporationStructuresTable.structureId,
            ],
            set: values,
          });
      }

      await tx
        .update(corporationStructureConnectionsTable)
        .set({ status: "connected", lastError: null, lastSyncedAt: syncedAt })
        .where(eq(corporationStructureConnectionsTable.corporationId, corporationId));
    });

    return { structures: structures.length, syncedAt };
  } catch (error) {
    await recordSyncError(corporationId, error, "建筑同步失败");
    throw error;
  }
}

export async function corporationStructuresDashboard(corporationId: number) {
  const [connection, structures] = await Promise.all([
    db
      .select()
      .from(corporationStructureConnectionsTable)
      .where(eq(corporationStructureConnectionsTable.corporationId, corporationId))
      .then((rows) => rows[0] ?? null),
    db
      .select({
        structureId: corporationStructuresTable.structureId,
        name: corporationStructuresTable.name,
        typeId: corporationStructuresTable.typeId,
        typeName: corporationStructuresTable.typeName,
        systemId: corporationStructuresTable.systemId,
        systemName: corporationStructuresTable.systemName,
        state: corporationStructuresTable.state,
        fuelExpiresAt: corporationStructuresTable.fuelExpiresAt,
        stateTimerStart: corporationStructuresTable.stateTimerStart,
        stateTimerEnd: corporationStructuresTable.stateTimerEnd,
        unanchorsAt: corporationStructuresTable.unanchorsAt,
        services: corporationStructuresTable.services,
        lastSeenAt: corporationStructuresTable.lastSeenAt,
      })
      .from(corporationStructuresTable)
      .where(and(
        eq(corporationStructuresTable.corporationId, corporationId),
        eq(corporationStructuresTable.isActive, true),
      ))
      .orderBy(asc(corporationStructuresTable.fuelExpiresAt), asc(corporationStructuresTable.name)),
  ]);

  return {
    connection: publicConnection(connection),
    serverTime: new Date(),
    structures,
  };
}
