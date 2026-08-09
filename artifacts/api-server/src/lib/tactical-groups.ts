import {
  db,
  fleetsTable,
  identityGroupMembershipsTable,
  identityGroupsTable,
  papRecordsTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export type TacticalFleetWindow = {
  fleetId: number;
  identityGroupId: number;
  identityGroupName: string;
  membershipCreatedAt: Date;
  startedAt: Date;
  endedAt: Date | null;
};

export async function getActiveTacticalMembership(
  corporationId: number,
  userId: number,
  identityGroupId: number,
) {
  const [row] = await db
    .select({ group: identityGroupsTable, membership: identityGroupMembershipsTable })
    .from(identityGroupsTable)
    .innerJoin(identityGroupMembershipsTable, and(
      eq(identityGroupMembershipsTable.groupId, identityGroupsTable.id),
      eq(identityGroupMembershipsTable.corporationId, corporationId),
      eq(identityGroupMembershipsTable.userId, userId),
    ))
    .where(and(
      eq(identityGroupsTable.id, identityGroupId),
      eq(identityGroupsTable.corporationId, corporationId),
      eq(identityGroupsTable.category, "combat"),
      eq(identityGroupsTable.isActive, true),
    ));
  return row ?? null;
}

export async function listUserTacticalFleetWindows(
  corporationId: number,
  userId: number,
  identityGroupId?: number,
): Promise<TacticalFleetWindow[]> {
  const rows = await db
    .select({
      fleetId: fleetsTable.id,
      identityGroupId: identityGroupsTable.id,
      identityGroupName: identityGroupsTable.name,
      membershipCreatedAt: identityGroupMembershipsTable.createdAt,
      fleetStartedAt: fleetsTable.startedAt,
      fleetCreatedAt: fleetsTable.createdAt,
      fleetEndedAt: fleetsTable.endedAt,
    })
    .from(papRecordsTable)
    .innerJoin(fleetsTable, and(
      eq(fleetsTable.id, papRecordsTable.fleetId),
      eq(fleetsTable.corporationId, corporationId),
    ))
    .innerJoin(identityGroupsTable, and(
      eq(identityGroupsTable.id, fleetsTable.identityGroupId),
      eq(identityGroupsTable.corporationId, corporationId),
      eq(identityGroupsTable.category, "combat"),
      eq(identityGroupsTable.isActive, true),
    ))
    .innerJoin(identityGroupMembershipsTable, and(
      eq(identityGroupMembershipsTable.groupId, identityGroupsTable.id),
      eq(identityGroupMembershipsTable.corporationId, corporationId),
      eq(identityGroupMembershipsTable.userId, userId),
    ))
    .where(and(
      eq(papRecordsTable.corporationId, corporationId),
      eq(papRecordsTable.userId, userId),
      eq(papRecordsTable.type, "fleet"),
      ...(identityGroupId === undefined ? [] : [eq(identityGroupsTable.id, identityGroupId)]),
    ))
    .orderBy(desc(fleetsTable.startedAt), desc(fleetsTable.createdAt));

  const uniqueFleets = new Map<number, TacticalFleetWindow>();
  for (const row of rows) {
    if (uniqueFleets.has(row.fleetId)) continue;
    uniqueFleets.set(row.fleetId, {
      fleetId: row.fleetId,
      identityGroupId: row.identityGroupId,
      identityGroupName: row.identityGroupName,
      membershipCreatedAt: row.membershipCreatedAt,
      startedAt: row.fleetStartedAt ?? row.fleetCreatedAt,
      endedAt: row.fleetEndedAt,
    });
  }
  return [...uniqueFleets.values()];
}

export function lossMatchesTacticalFleet(
  occurredAt: Date,
  window: TacticalFleetWindow,
  now = new Date(),
): boolean {
  const lossTime = occurredAt.getTime();
  return Number.isFinite(lossTime)
    && window.membershipCreatedAt.getTime() <= lossTime
    && window.startedAt.getTime() <= lossTime
    && lossTime <= (window.endedAt ?? now).getTime();
}

export async function resolveTacticalClaimRoute(
  corporationId: number,
  userId: number,
  occurredAt: Date,
  requestedIdentityGroupId?: number,
) {
  const windows = await listUserTacticalFleetWindows(
    corporationId,
    userId,
    requestedIdentityGroupId,
  );
  const match = windows.find((window) => lossMatchesTacticalFleet(occurredAt, window));
  return match
    ? {
        fleetId: match.fleetId,
        identityGroupId: match.identityGroupId,
        identityGroupName: match.identityGroupName,
      }
    : null;
}
