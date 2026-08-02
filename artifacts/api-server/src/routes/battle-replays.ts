import { Router, type IRouter, type Request, type Response } from "express";
import {
  battleReportReviewsTable,
  battleReportsTable,
  db,
} from "@workspace/db";
import {
  AnalyzeBattleReplayParams,
  GetBattleReplayParams,
  UpdateBattleReplayBody,
  UpdateBattleReplayParams,
} from "@workspace/api-zod";
import { and, desc, eq, sql } from "drizzle-orm";
import { requireAuth, requireRoleOrPermission } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import {
  loadBattleReportDetail,
  reportSummarySelection,
} from "../lib/battle-report-data";
import { queueBattleReplayAnalysis } from "../lib/battle-replay-analysis";

const router: IRouter = Router();
router.use("/command/battle-replays", requireAuth, requireTenant, requireModule("fleet"));

function serializeReview(review: typeof battleReportReviewsTable.$inferSelect) {
  return {
    status: review.status,
    aiStatus: review.aiStatus,
    aiSource: review.aiSource,
    aiModel: review.aiModel,
    aiError: review.aiError,
    aiAnalysis: review.aiAnalysis,
    manualNodes: review.manualNodes,
    conclusion: review.conclusion,
    aiAnalyzedAt: review.aiAnalyzedAt,
    publishedAt: review.publishedAt,
    updatedAt: review.updatedAt,
  };
}

router.get(
  "/command/battle-replays",
  requireRoleOrPermission("fc", "fleet.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const reports = await db
      .select({
        ...reportSummarySelection(),
        reviewStatus: sql<
          "not_started" | "draft" | "published"
        >`COALESCE(${battleReportReviewsTable.status}, 'not_started')`,
        aiStatus: sql<
          "not_started" | "generating" | "ready" | "failed"
        >`COALESCE(${battleReportReviewsTable.aiStatus}, 'not_started')`,
        reviewUpdatedAt: battleReportReviewsTable.updatedAt,
      })
      .from(battleReportsTable)
      .leftJoin(
        battleReportReviewsTable,
        eq(battleReportReviewsTable.battleReportId, battleReportsTable.id),
      )
      .where(eq(battleReportsTable.corporationId, req.tenant!.corporation.id))
      .orderBy(desc(battleReportsTable.endedAt))
      .limit(100);

    res.json(reports);
  },
);

router.get(
  "/command/battle-replays/:id",
  requireRoleOrPermission("fc", "fleet.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const params = GetBattleReplayParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const report = await loadBattleReportDetail(params.data.id, req.tenant!.corporation.id);
    if (!report) {
      res.status(404).json({ error: "Battle report not found" });
      return;
    }

    const [review] = await db
      .select()
      .from(battleReportReviewsTable)
      .where(eq(battleReportReviewsTable.battleReportId, report.id));
    res.json({
      ...report,
      publishedReview:
        review?.status === "published" ? serializeReview(review) : null,
      review: review ? serializeReview(review) : null,
    });
  },
);

router.put(
  "/command/battle-replays/:id",
  requireRoleOrPermission("fc", "fleet.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const params = UpdateBattleReplayParams.safeParse(req.params);
    const body = UpdateBattleReplayBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    const [report] = await db
      .select({ id: battleReportsTable.id })
      .from(battleReportsTable)
      .where(and(
        eq(battleReportsTable.id, params.data.id),
        eq(battleReportsTable.corporationId, req.tenant!.corporation.id),
      ));
    if (!report) {
      res.status(404).json({ error: "Battle report not found" });
      return;
    }

    const publishedAt = body.data.status === "published" ? new Date() : null;
    const manualNodes = body.data.manualNodes.map((node) => ({
      ...node,
      occurredAt: node.occurredAt.toISOString(),
    }));
    const [review] = await db
      .insert(battleReportReviewsTable)
      .values({
        battleReportId: report.id,
        status: body.data.status,
        conclusion: body.data.conclusion.trim(),
        manualNodes,
        updatedBy: req.session.userId!,
        publishedAt,
      })
      .onConflictDoUpdate({
        target: battleReportReviewsTable.battleReportId,
        set: {
          status: body.data.status,
          conclusion: body.data.conclusion.trim(),
          manualNodes,
          updatedBy: req.session.userId!,
          publishedAt,
          updatedAt: new Date(),
        },
      })
      .returning();

    res.json(serializeReview(review));
  },
);

router.post(
  "/command/battle-replays/:id/analyze",
  requireRoleOrPermission("fc", "fleet.manage"),
  async (req: Request, res: Response): Promise<void> => {
    const params = AnalyzeBattleReplayParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    const [report] = await db
      .select({ id: battleReportsTable.id })
      .from(battleReportsTable)
      .where(and(
        eq(battleReportsTable.id, params.data.id),
        eq(battleReportsTable.corporationId, req.tenant!.corporation.id),
      ));
    if (!report) {
      res.status(404).json({ error: "Battle report not found" });
      return;
    }

    await queueBattleReplayAnalysis(report.id, req.session.userId!);
    res.status(202).json({ status: "generating" });
  },
);

export default router;
