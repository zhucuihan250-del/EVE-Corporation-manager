import { Router, type IRouter, type Request, type Response } from "express";
import {
  battleReportReviewsTable,
  battleReportsTable,
  db,
  usersTable,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  GetBattleReportParams,
  RefreshBattleReportParams,
} from "@workspace/api-zod";
import { hasRole, requireAuth } from "../middlewares/auth";
import { queueBattleReportGeneration } from "../lib/battle-reports";
import {
  loadBattleReportDetail,
  reportSummarySelection,
} from "../lib/battle-report-data";

const router: IRouter = Router();

function scheduleAutomaticRefresh(report: {
  id: number;
  status: string;
  endedAt: Date;
  lastSyncedAt: Date | null;
}): void {
  const now = Date.now();
  const isWithinAutomaticWindow =
    report.endedAt.getTime() >= now - 7 * 24 * 60 * 60_000;
  if (!isWithinAutomaticWindow) return;

  if (report.status === "pending" || report.status === "failed") {
    queueBattleReportGeneration(report.id);
    return;
  }

  const isRecentBattle = report.endedAt.getTime() >= now - 2 * 60 * 60_000;
  const isStale =
    !report.lastSyncedAt || report.lastSyncedAt.getTime() < now - 5 * 60_000;
  if (isRecentBattle && isStale && report.status !== "generating") {
    queueBattleReportGeneration(report.id, true);
  }
}

// All authenticated corporation members may read battle reports.
router.get(
  "/battle-reports",
  requireAuth,
  async (_req: Request, res: Response): Promise<void> => {
    const reports = await db
      .select(reportSummarySelection())
      .from(battleReportsTable)
      .orderBy(desc(battleReportsTable.endedAt))
      .limit(100);

    for (const report of reports.slice(0, 5)) scheduleAutomaticRefresh(report);
    res.json(reports);
  },
);

router.get(
  "/battle-reports/:id",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const params = GetBattleReportParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const report = await loadBattleReportDetail(params.data.id);
    if (!report) {
      res.status(404).json({ error: "Battle report not found" });
      return;
    }

    const [publishedReview] = await db
      .select({
        status: battleReportReviewsTable.status,
        aiStatus: battleReportReviewsTable.aiStatus,
        aiSource: battleReportReviewsTable.aiSource,
        aiModel: battleReportReviewsTable.aiModel,
        aiAnalysis: battleReportReviewsTable.aiAnalysis,
        manualNodes: battleReportReviewsTable.manualNodes,
        conclusion: battleReportReviewsTable.conclusion,
        aiAnalyzedAt: battleReportReviewsTable.aiAnalyzedAt,
        publishedAt: battleReportReviewsTable.publishedAt,
        updatedAt: battleReportReviewsTable.updatedAt,
      })
      .from(battleReportReviewsTable)
      .where(
        and(
          eq(battleReportReviewsTable.battleReportId, report.id),
          eq(battleReportReviewsTable.status, "published"),
        ),
      );

    scheduleAutomaticRefresh(report);
    res.json({ ...report, publishedReview: publishedReview ?? null });
  },
);

// FC and above may request an immediate re-sync; read access remains available to every member.
router.post(
  "/battle-reports/:id/refresh",
  requireAuth,
  async (req: Request, res: Response): Promise<void> => {
    const [currentUser] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.session.userId!));
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
  },
);

export default router;
