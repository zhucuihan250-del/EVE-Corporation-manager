import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, fleetsTable, papRecordsTable, redemptionsTable } from "@workspace/db";
import { eq, desc, sum, count, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

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
  if (!currentUser || currentUser.role !== "admin") {
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
      fleetCount: sql<number>`(
        SELECT COUNT(*) FROM pap_records
        WHERE user_id = ${usersTable.id} AND type = 'fleet'
      )`,
    })
    .from(usersTable)
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
      pingType: fleetsTable.pingType,
      status: fleetsTable.status,
      scheduledAt: fleetsTable.scheduledAt,
      startedAt: fleetsTable.startedAt,
      endedAt: fleetsTable.endedAt,
      createdAt: fleetsTable.createdAt,
      participantCount: sql<number>`(
        SELECT COUNT(*) FROM pap_records
        WHERE fleet_id = ${fleetsTable.id} AND type = 'fleet'
      )`,
    })
    .from(fleetsTable)
    .orderBy(desc(fleetsTable.createdAt))
    .limit(100);

  res.json(fleets);
});

export default router;
