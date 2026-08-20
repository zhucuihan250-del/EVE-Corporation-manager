import { Router, type IRouter, type Request, type Response } from "express";
import { corporationMembershipsTable, db, usersTable, fleetsTable, papRecordsTable, redemptionsTable } from "@workspace/db";
import { eq, desc, asc, count, sql, and, sum, gte } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { availablePap } from "../lib/pap-balance";

const router: IRouter = Router();
router.use("/dashboard", requireAuth, requireTenant, requireModule("pap"));

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function getTopContributors(corporationId: number, since?: Date) {
  const fleetCount = sql<number>`COUNT(DISTINCT ${papRecordsTable.fleetId})::int`;
  const totalPap = since
    ? sql<number>`COALESCE(SUM(${papRecordsTable.amount}), 0)::real`
    : sql<number>`COALESCE((
        SELECT SUM(p."amount")::real FROM "pap_records" p
        WHERE p."user_id" = ${usersTable.id} AND p."corporation_id" = ${corporationId}
      ), 0)::real`;
  const userName = sql<string | null>`(
    SELECT c."eve_character_name" FROM "characters" c
    WHERE c."user_id" = ${usersTable.id}
      AND c."corporation_id" = ${corporationId}
      AND c."deleted_at" IS NULL
    ORDER BY c."is_main" DESC, c."created_at" ASC LIMIT 1
  )`;
  const fleetRecordCondition = since
    ? and(
        eq(papRecordsTable.userId, usersTable.id),
        eq(papRecordsTable.corporationId, corporationId),
        eq(papRecordsTable.type, "fleet"),
        gte(papRecordsTable.createdAt, since),
      )
    : and(
        eq(papRecordsTable.userId, usersTable.id),
        eq(papRecordsTable.corporationId, corporationId),
        eq(papRecordsTable.type, "fleet"),
      );

  return db
    .select({
      userId: usersTable.id,
      userName,
      totalPap,
      fleetCount,
    })
    .from(usersTable)
    .innerJoin(
      corporationMembershipsTable,
      and(
        eq(corporationMembershipsTable.userId, usersTable.id),
        eq(corporationMembershipsTable.corporationId, corporationId),
      ),
    )
    .leftJoin(papRecordsTable, fleetRecordCondition)
    .groupBy(usersTable.id)
    .having(sql`${fleetCount} > 0`)
    .orderBy(desc(fleetCount), desc(totalPap), asc(userName))
    .limit(10);
}

// GET /api/dashboard/summary - current user
router.get("/dashboard/summary", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return;
  }

  const [fleetCountResult] = await db
    .select({ count: count() })
    .from(papRecordsTable)
    .where(and(
      eq(papRecordsTable.userId, user.id),
      eq(papRecordsTable.corporationId, req.tenant!.corporation.id),
    ));

  const [redemptionCountResult] = await db
    .select({ count: count() })
    .from(redemptionsTable)
    .where(and(
      eq(redemptionsTable.userId, user.id),
      eq(redemptionsTable.corporationId, req.tenant!.corporation.id),
    ));

  // PAP earned in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [recentPapResult] = await db
    .select({ total: sum(papRecordsTable.amount) })
    .from(papRecordsTable)
    .where(
      and(
        eq(papRecordsTable.userId, user.id),
        eq(papRecordsTable.corporationId, req.tenant!.corporation.id),
        gte(papRecordsTable.createdAt, thirtyDaysAgo),
        sql`${papRecordsTable.amount} > 0`,
      ),
    );

  res.json({
    pap: availablePap(user.redeemablePap, user.lockedPap),
    totalPap: user.redeemablePap,
    redeemablePap: user.redeemablePap,
    availablePap: availablePap(user.redeemablePap, user.lockedPap),
    lockedPap: user.lockedPap,
    fleetCount: fleetCountResult.count,
    redemptionCount: redemptionCountResult.count,
    recentPapEarned: Number(recentPapResult.total ?? 0),
  });
});

// GET /api/dashboard/admin-summary - admin only
router.get("/dashboard/admin-summary", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [totalUsersResult] = await db.select({ count: count() }).from(corporationMembershipsTable)
    .where(eq(corporationMembershipsTable.corporationId, req.tenant!.corporation.id));
  const [totalFleetsResult] = await db.select({ count: count() }).from(fleetsTable)
    .where(eq(fleetsTable.corporationId, req.tenant!.corporation.id));
  const [activeFleetsResult] = await db
    .select({ count: count() })
    .from(fleetsTable)
    .where(and(eq(fleetsTable.isActive, true), eq(fleetsTable.corporationId, req.tenant!.corporation.id)));
  const [totalPapResult] = await db
    .select({ total: sum(papRecordsTable.amount) })
    .from(papRecordsTable)
    .where(and(sql`${papRecordsTable.amount} > 0`, eq(papRecordsTable.corporationId, req.tenant!.corporation.id)));
  const [totalRedemptionsResult] = await db.select({ count: count() }).from(redemptionsTable)
    .where(eq(redemptionsTable.corporationId, req.tenant!.corporation.id));
  const [pendingRedemptionsResult] = await db
    .select({ count: count() })
    .from(redemptionsTable)
    .where(and(eq(redemptionsTable.status, "pending"), eq(redemptionsTable.corporationId, req.tenant!.corporation.id)));

  res.json({
    totalUsers: totalUsersResult.count,
    totalFleets: totalFleetsResult.count,
    totalPapAwarded: Number(totalPapResult.total ?? 0),
    totalRedemptions: totalRedemptionsResult.count,
    activeFleets: activeFleetsResult.count,
    pendingRedemptions: pendingRedemptionsResult.count,
  });
});

// GET /api/dashboard/top-contributors
router.get("/dashboard/top-contributors", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const contributors = await getTopContributors(req.tenant!.corporation.id);

  res.json(contributors);
});

// GET /api/dashboard/top-contributors/30-days
router.get("/dashboard/top-contributors/30-days", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const contributors = await getTopContributors(req.tenant!.corporation.id, new Date(Date.now() - THIRTY_DAYS_MS));

  res.json(contributors);
});

// GET /api/dashboard/recent-fleets
router.get("/dashboard/recent-fleets", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const fleets = await db
    .select({
      id: fleetsTable.id,
      eveFleetId: fleetsTable.eveFleetId,
      name: fleetsTable.name,
      fleetCommander: fleetsTable.fleetCommander,
      papValue: fleetsTable.papValue,
      isActive: fleetsTable.isActive,
      startedAt: fleetsTable.startedAt,
      endedAt: fleetsTable.endedAt,
      createdAt: fleetsTable.createdAt,
      participantCount: sql<number>`(
        SELECT COUNT(*)::int FROM "pap_records"
        WHERE "pap_records"."fleet_id" = "fleets"."id"
        AND "pap_records"."type" = 'fleet'
      )`,
    })
    .from(fleetsTable)
    .where(eq(fleetsTable.corporationId, req.tenant!.corporation.id))
    .orderBy(desc(fleetsTable.createdAt))
    .limit(5);

  res.json(fleets);
});

// GET /api/dashboard/pap-history - daily PAP for last 30 days (current user)
router.get("/dashboard/pap-history", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const userId = req.session.userId!;

  const rows = await db.execute<{ date: string; pap: number }>(
    sql`SELECT DATE(created_at)::text AS date, SUM(amount)::int AS pap
        FROM pap_records
        WHERE user_id = ${userId}
          AND corporation_id = ${req.tenant!.corporation.id}
          AND created_at >= NOW() - INTERVAL '30 days'
          AND amount > 0
        GROUP BY DATE(created_at)
        ORDER BY date ASC`
  );

  const byDate: Record<string, number> = {};
  for (const row of rows.rows) {
    byDate[row.date] = row.pap;
  }

  const result: { date: string; pap: number }[] = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    result.push({ date: key, pap: byDate[key] ?? 0 });
  }

  res.json(result);
});

export default router;
