import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, fleetsTable, papRecordsTable, redemptionsTable } from "@workspace/db";
import { eq, desc, count, sql, and, sum } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";

const router: IRouter = Router();

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
    .where(eq(papRecordsTable.userId, user.id));

  const [redemptionCountResult] = await db
    .select({ count: count() })
    .from(redemptionsTable)
    .where(eq(redemptionsTable.userId, user.id));

  // PAP earned in last 30 days
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [recentPapResult] = await db
    .select({ total: sum(papRecordsTable.amount) })
    .from(papRecordsTable)
    .where(
      sql`${papRecordsTable.userId} = ${user.id} AND ${papRecordsTable.createdAt} >= ${thirtyDaysAgo} AND ${papRecordsTable.amount} > 0`
    );

  res.json({
    totalPap: user.totalPap,
    redeemablePap: user.redeemablePap,
    fleetCount: fleetCountResult.count,
    redemptionCount: redemptionCountResult.count,
    recentPapEarned: Number(recentPapResult.total ?? 0),
  });
});

// GET /api/dashboard/admin-summary - admin only
router.get("/dashboard/admin-summary", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const [totalUsersResult] = await db.select({ count: count() }).from(usersTable);
  const [totalFleetsResult] = await db.select({ count: count() }).from(fleetsTable);
  const [activeFleetsResult] = await db
    .select({ count: count() })
    .from(fleetsTable)
    .where(eq(fleetsTable.isActive, true));
  const [totalPapResult] = await db
    .select({ total: sum(papRecordsTable.amount) })
    .from(papRecordsTable)
    .where(sql`${papRecordsTable.amount} > 0`);
  const [totalRedemptionsResult] = await db.select({ count: count() }).from(redemptionsTable);
  const [pendingRedemptionsResult] = await db
    .select({ count: count() })
    .from(redemptionsTable)
    .where(eq(redemptionsTable.status, "pending"));

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
  const contributors = await db
    .select({
      userId: usersTable.id,
      userName: usersTable.eveCharacterName,
      totalPap: usersTable.totalPap,
      fleetCount: sql<number>`COUNT(DISTINCT ${papRecordsTable.fleetId})::int`,
    })
    .from(usersTable)
    .leftJoin(
      papRecordsTable,
      and(eq(papRecordsTable.userId, usersTable.id), eq(papRecordsTable.type, "fleet")),
    )
    .groupBy(usersTable.id)
    .orderBy(desc(usersTable.totalPap))
    .limit(10);

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
