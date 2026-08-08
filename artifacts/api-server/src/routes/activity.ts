import { Router, type IRouter, type Request, type Response } from "express";
import {
  corporationMembershipsTable,
  corporationsTable,
  db,
  papRecordsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { ensureCorporationJoinedAt } from "../lib/corporation-membership";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();
const ELIGIBILITY_DAYS = 60;
const DAY_MS = 24 * 60 * 60 * 1_000;
const JOIN_DATE_LOOKUP_CONCURRENCY = 4;

router.use("/activity", requireAuth, requireTenant, requireModule("pap"));

function canManage(req: Request): boolean {
  return Boolean(
    req.tenant
    && (hasPermission(req.tenant, "activity.manage")
      || hasRole(req.tenant.membership.role, "admin")),
  );
}

function parseMonth(value: unknown): { month: string; start: Date; end: Date; evaluatedAt: Date } | null {
  const now = new Date();
  if (value !== undefined && (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value))) {
    return null;
  }
  const month = typeof value === "string"
    ? value
    : `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const [year, monthNumber] = month.split("-").map(Number);
  const start = new Date(Date.UTC(year, monthNumber - 1, 1));
  const end = new Date(Date.UTC(year, monthNumber, 1));
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  if (start.getTime() > currentMonthStart.getTime()) return null;
  return {
    month,
    start,
    end,
    evaluatedAt: now.getTime() < end.getTime() ? now : new Date(end.getTime() - 1),
  };
}

async function resolveJoinDates<T extends {
  user: typeof usersTable.$inferSelect;
  role: "member" | "fc" | "admin" | "controller";
}>(members: T[]): Promise<T[]> {
  const resolved = [...members];
  let nextIndex = 0;
  const workerCount = Math.min(JOIN_DATE_LOOKUP_CONCURRENCY, members.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < members.length) {
      const index = nextIndex;
      nextIndex += 1;
      const member = resolved[index];
      if (!member.user.corporationJoinedAt) {
        const corporationJoinedAt = await ensureCorporationJoinedAt(member.user);
        if (corporationJoinedAt) {
          resolved[index] = { ...member, user: { ...member.user, corporationJoinedAt } };
        }
      }
    }
  }));
  return resolved;
}

router.get("/activity", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const period = parseMonth(req.query.month);
  if (!period) {
    res.status(400).json({ error: "Month must use YYYY-MM and must not be in the future" });
    return;
  }
  const tenant = req.tenant!;
  const rawMembers = await db
    .select({ user: usersTable, role: corporationMembershipsTable.role })
    .from(corporationMembershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, corporationMembershipsTable.userId))
    .where(and(
      eq(corporationMembershipsTable.corporationId, tenant.corporation.id),
      eq(usersTable.corporationId, tenant.corporation.id),
      isNotNull(usersTable.eveCharacterId),
      isNotNull(usersTable.eveCharacterName),
    ));
  const members = await resolveJoinDates(rawMembers);
  const papRows = await db
    .select({
      userId: papRecordsTable.userId,
      pap: sql<number>`COALESCE(SUM(${papRecordsTable.amount}), 0)::float8`,
      papRecords: sql<number>`COUNT(*)::int`,
    })
    .from(papRecordsTable)
    .where(and(
      eq(papRecordsTable.corporationId, tenant.corporation.id),
      gte(papRecordsTable.createdAt, period.start),
      lt(papRecordsTable.createdAt, period.end),
    ))
    .groupBy(papRecordsTable.userId);
  const papByUser = new Map(papRows.map((row) => [row.userId, row]));
  const minimumPap = Number(tenant.corporation.activityMinimumPap);
  const eligibleMembers = members.flatMap((member) => {
    const joinedAt = member.user.corporationJoinedAt;
    if (!joinedAt) return [];
    const daysInCorporation = Math.max(0, Math.floor((period.evaluatedAt.getTime() - joinedAt.getTime()) / DAY_MS));
    if (daysInCorporation < ELIGIBILITY_DAYS) return [];
    const totals = papByUser.get(member.user.id);
    const pap = Number(totals?.pap ?? 0);
    const metRequirement = pap >= minimumPap;
    return [{
      userId: member.user.id,
      characterName: member.user.eveCharacterName!,
      role: member.role,
      corporationJoinedAt: joinedAt,
      daysInCorporation,
      pap,
      papRecords: Number(totals?.papRecords ?? 0),
      remainingPap: Math.max(0, minimumPap - pap),
      metRequirement,
    }];
  }).sort((left, right) => {
    if (left.metRequirement !== right.metRequirement) return left.metRequirement ? 1 : -1;
    if (left.pap !== right.pap) return left.pap - right.pap;
    return left.characterName.localeCompare(right.characterName);
  });
  const meetingRequirement = eligibleMembers.filter((member) => member.metRequirement).length;

  res.json({
    month: period.month,
    periodStart: period.start,
    periodEnd: period.end,
    evaluatedAt: period.evaluatedAt,
    eligibilityDays: ELIGIBILITY_DAYS,
    minimumPap,
    totalEligible: eligibleMembers.length,
    meetingRequirement,
    belowRequirement: eligibleMembers.length - meetingRequirement,
    members: eligibleMembers,
  });
});

router.patch("/activity/settings", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const minimumPap = Number(req.body.minimumPap);
  if (!Number.isFinite(minimumPap) || minimumPap < 0 || minimumPap > 1_000) {
    res.status(400).json({ error: "minimumPap must be between 0 and 1000" });
    return;
  }
  const [corporation] = await db.update(corporationsTable).set({
    activityMinimumPap: minimumPap,
  }).where(eq(corporationsTable.id, req.tenant!.corporation.id)).returning();
  res.json({ minimumPap: corporation.activityMinimumPap, eligibilityDays: ELIGIBILITY_DAYS });
});

export default router;
