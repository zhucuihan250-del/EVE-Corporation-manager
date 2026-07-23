import {
  battleReportKillmailsTable,
  battleReportParticipantsTable,
  battleReportsTable,
  db,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";

const participantCountSql = sql<number>`(
  SELECT COUNT(*)::int
  FROM "battle_report_participants"
  WHERE "battle_report_participants"."battle_report_id" = "battle_reports"."id"
)`;

const systemCountSql = sql<number>`(
  SELECT COUNT(DISTINCT "battle_report_killmails"."solar_system_id")::int
  FROM "battle_report_killmails"
  WHERE "battle_report_killmails"."battle_report_id" = "battle_reports"."id"
)`;

export function reportSummarySelection() {
  return {
    id: battleReportsTable.id,
    fleetId: battleReportsTable.fleetId,
    fleetName: battleReportsTable.fleetName,
    fleetCommander: battleReportsTable.fleetCommander,
    startedAt: battleReportsTable.startedAt,
    endedAt: battleReportsTable.endedAt,
    status: battleReportsTable.status,
    errorMessage: battleReportsTable.errorMessage,
    totalDestroyed: battleReportsTable.totalDestroyed,
    totalLost: battleReportsTable.totalLost,
    damageDealt: battleReportsTable.damageDealt,
    killmailCount: battleReportsTable.killmailCount,
    friendlyLosses: battleReportsTable.friendlyLosses,
    hostileLosses: battleReportsTable.hostileLosses,
    primarySystemId: battleReportsTable.primarySystemId,
    primarySystemName: battleReportsTable.primarySystemName,
    generatedAt: battleReportsTable.generatedAt,
    lastSyncedAt: battleReportsTable.lastSyncedAt,
    createdAt: battleReportsTable.createdAt,
    participantCount: participantCountSql,
    systemCount: systemCountSql,
  };
}

export async function loadBattleReportDetail(reportId: number) {
  const [report] = await db
    .select(reportSummarySelection())
    .from(battleReportsTable)
    .where(eq(battleReportsTable.id, reportId));
  if (!report) return null;

  const [participants, killmails, systems] = await Promise.all([
    db
      .select({
        id: battleReportParticipantsTable.id,
        eveCharacterId: battleReportParticipantsTable.eveCharacterId,
        characterName: battleReportParticipantsTable.characterName,
        corporationId: battleReportParticipantsTable.corporationId,
        corporationName: battleReportParticipantsTable.corporationName,
        primaryShipTypeId: battleReportParticipantsTable.primaryShipTypeId,
        primaryShipName: battleReportParticipantsTable.primaryShipName,
        damageDealt: battleReportParticipantsTable.damageDealt,
        killsInvolved: battleReportParticipantsTable.killsInvolved,
        finalBlows: battleReportParticipantsTable.finalBlows,
        losses: battleReportParticipantsTable.losses,
      })
      .from(battleReportParticipantsTable)
      .where(eq(battleReportParticipantsTable.battleReportId, report.id))
      .orderBy(desc(battleReportParticipantsTable.damageDealt)),
    db
      .select({
        id: battleReportKillmailsTable.id,
        killmailId: battleReportKillmailsTable.killmailId,
        killmailTime: battleReportKillmailsTable.killmailTime,
        solarSystemId: battleReportKillmailsTable.solarSystemId,
        solarSystemName: battleReportKillmailsTable.solarSystemName,
        victimCharacterId: battleReportKillmailsTable.victimCharacterId,
        victimCharacterName: battleReportKillmailsTable.victimCharacterName,
        victimCorporationId: battleReportKillmailsTable.victimCorporationId,
        victimCorporationName: battleReportKillmailsTable.victimCorporationName,
        victimAllianceId: battleReportKillmailsTable.victimAllianceId,
        victimAllianceName: battleReportKillmailsTable.victimAllianceName,
        victimShipTypeId: battleReportKillmailsTable.victimShipTypeId,
        victimShipName: battleReportKillmailsTable.victimShipName,
        victimIsFleetMember: battleReportKillmailsTable.victimIsFleetMember,
        totalValue: battleReportKillmailsTable.totalValue,
        damageTaken: battleReportKillmailsTable.damageTaken,
        friendlyDamage: battleReportKillmailsTable.friendlyDamage,
        friendlyAttackers: battleReportKillmailsTable.friendlyAttackers,
        finalBlowByFleet: battleReportKillmailsTable.finalBlowByFleet,
        attackers: battleReportKillmailsTable.attackers,
        zkillboardUrl: battleReportKillmailsTable.zkillboardUrl,
      })
      .from(battleReportKillmailsTable)
      .where(eq(battleReportKillmailsTable.battleReportId, report.id))
      .orderBy(desc(battleReportKillmailsTable.killmailTime)),
    db
      .select({
        solarSystemId: battleReportKillmailsTable.solarSystemId,
        solarSystemName: battleReportKillmailsTable.solarSystemName,
        killmailCount: sql<number>`COUNT(*)::int`,
        friendlyLosses: sql<number>`COUNT(*) FILTER (WHERE ${battleReportKillmailsTable.victimIsFleetMember})::int`,
        hostileLosses: sql<number>`COUNT(*) FILTER (WHERE NOT ${battleReportKillmailsTable.victimIsFleetMember})::int`,
        destroyedValue: sql<number>`COALESCE(SUM(${battleReportKillmailsTable.totalValue}) FILTER (WHERE NOT ${battleReportKillmailsTable.victimIsFleetMember}), 0)::float8`,
        lostValue: sql<number>`COALESCE(SUM(${battleReportKillmailsTable.totalValue}) FILTER (WHERE ${battleReportKillmailsTable.victimIsFleetMember}), 0)::float8`,
      })
      .from(battleReportKillmailsTable)
      .where(eq(battleReportKillmailsTable.battleReportId, report.id))
      .groupBy(
        battleReportKillmailsTable.solarSystemId,
        battleReportKillmailsTable.solarSystemName,
      )
      .orderBy(desc(sql`COUNT(*)`)),
  ]);

  return { ...report, participants, killmails, systems };
}
