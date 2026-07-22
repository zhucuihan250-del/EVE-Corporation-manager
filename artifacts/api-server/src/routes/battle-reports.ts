import { Router, type IRouter, type Request, type Response } from "express";
import {
  battleReportKillmailsTable,
  battleReportParticipantsTable,
  battleReportsTable,
  db,
  usersTable,
} from "@workspace/db";
import { desc, eq, sql } from "drizzle-orm";
import { GetBattleReportParams, RefreshBattleReportParams } from "@workspace/api-zod";
import { hasRole, requireAuth } from "../middlewares/auth";
import { queueBattleReportGeneration } from "../lib/battle-reports";

const router: IRouter = Router();

const participantCountSql = sql<number>`(
  SELECT COUNT(*)::int
  FROM "battle_report_participants"
  WHERE "battle_report_participants"."battle_report_id" = "battle_reports"."id"
)`;

function reportSummarySelection() {
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
  };
}

function scheduleAutomaticRefresh(report: {
  id: number;
  status: string;
  endedAt: Date;
  lastSyncedAt: Date | null;
}): void {
  const now = Date.now();
  const isWithinAutomaticWindow = report.endedAt.getTime() >= now - 7 * 24 * 60 * 60_000;
  if (!isWithinAutomaticWindow) return;

  if (report.status === "pending" || report.status === "failed") {
    queueBattleReportGeneration(report.id);
    return;
  }

  const isRecentBattle = report.endedAt.getTime() >= now - 2 * 60 * 60_000;
  const isStale = !report.lastSyncedAt || report.lastSyncedAt.getTime() < now - 5 * 60_000;
  if (isRecentBattle && isStale && report.status !== "generating") {
    queueBattleReportGeneration(report.id, true);
  }
}

// All authenticated corporation members may read battle reports.
router.get("/battle-reports", requireAuth, async (_req: Request, res: Response): Promise<void> => {
  const reports = await db
    .select(reportSummarySelection())
    .from(battleReportsTable)
    .orderBy(desc(battleReportsTable.endedAt))
    .limit(100);

  for (const report of reports.slice(0, 5)) scheduleAutomaticRefresh(report);
  res.json(reports);
});

router.get("/battle-reports/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const params = GetBattleReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [report] = await db
    .select(reportSummarySelection())
    .from(battleReportsTable)
    .where(eq(battleReportsTable.id, params.data.id));
  if (!report) {
    res.status(404).json({ error: "Battle report not found" });
    return;
  }

  const [participants, killmails] = await Promise.all([
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
        zkillboardUrl: battleReportKillmailsTable.zkillboardUrl,
      })
      .from(battleReportKillmailsTable)
      .where(eq(battleReportKillmailsTable.battleReportId, report.id))
      .orderBy(desc(battleReportKillmailsTable.killmailTime)),
  ]);

  scheduleAutomaticRefresh(report);
  res.json({ ...report, participants, killmails });
});

// FC and above may request an immediate re-sync; read access remains available to every member.
router.post("/battle-reports/:id/refresh", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "fc")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = RefreshBattleReportParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [report] = await db
    .select({ id: battleReportsTable.id })
    .from(battleReportsTable)
    .where(eq(battleReportsTable.id, params.data.id));
  if (!report) {
    res.status(404).json({ error: "Battle report not found" });
    return;
  }

  queueBattleReportGeneration(report.id, true);
  res.status(202).json({ status: "generating" });
});

export default router;
