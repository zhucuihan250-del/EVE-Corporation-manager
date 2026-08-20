import { Router, type IRouter, type Request, type Response } from "express";
import {
  activityMonthlyDeductionsTable,
  activityMonthlySettlementsTable,
  corporationMembershipsTable,
  corporationsTable,
  db,
  usersTable,
} from "@workspace/db";
import { and, eq, isNotNull } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { ensureCorporationJoinedAt } from "../lib/corporation-membership";
import { generateOauthState, getCorporationRosterAuthorizationUrl } from "../lib/eve-sso";
import { getCorporationRosterConnection, getRecentUnboundMemberAudit } from "../lib/corporation-roster";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";
import { ACTIVITY_ELIGIBILITY_DAYS } from "../lib/activity-monthly-settlement";
import { ACTIVITY_MONTHLY_PAP_DEDUCTION, calculateActivityPapDeduction } from "../lib/activity-rules";
import { availablePap } from "../lib/pap-balance";

const router: IRouter = Router();
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

function getCallbackUrl(req: Request): string {
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? req.protocol ?? "https";
  return `${proto}://${host}/api/auth/eve/callback`;
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
  const [settlement] = await db
    .select()
    .from(activityMonthlySettlementsTable)
    .where(and(
      eq(activityMonthlySettlementsTable.corporationId, tenant.corporation.id),
      eq(activityMonthlySettlementsTable.month, period.month),
    ));
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
  const deductionRows = settlement
    ? await db
      .select({
        userId: activityMonthlyDeductionsTable.userId,
        amount: activityMonthlyDeductionsTable.amount,
      })
      .from(activityMonthlyDeductionsTable)
      .where(and(
        eq(activityMonthlyDeductionsTable.corporationId, tenant.corporation.id),
        eq(activityMonthlyDeductionsTable.settlementId, settlement.id),
      ))
    : [];
  const deductionByUser = new Map(deductionRows.map((row) => [row.userId, Number(row.amount)]));
  const minimumPap = ACTIVITY_MONTHLY_PAP_DEDUCTION;
  const settlementStatus = settlement
    ? "settled"
    : period.end.getTime() <= tenant.corporation.activityDeductionStartedAt.getTime()
      ? "not_applicable"
      : period.end.getTime() > Date.now()
        ? "scheduled"
        : "pending";
  const eligibleMembers = members.flatMap((member) => {
    const joinedAt = member.user.corporationJoinedAt;
    if (!joinedAt) return [];
    const daysInCorporation = Math.max(0, Math.floor((period.evaluatedAt.getTime() - joinedAt.getTime()) / DAY_MS));
    if (daysInCorporation < ACTIVITY_ELIGIBILITY_DAYS) return [];
    const currentAvailablePap = availablePap(member.user.redeemablePap, member.user.lockedPap);
    const settledDeductionPap = settlement ? (deductionByUser.get(member.user.id) ?? 0) : null;
    const outcome = calculateActivityPapDeduction(
      settledDeductionPap === null ? currentAvailablePap : settledDeductionPap,
    );
    const hasInsufficientPapAlert = settlementStatus !== "not_applicable" && outcome.hasInsufficientPap;
    const deductionShortfallPap = hasInsufficientPapAlert ? outcome.shortfallPap : 0;
    const deductionStatus = settlementStatus === "not_applicable"
      ? "not_applicable"
      : settledDeductionPap !== null
        ? hasInsufficientPapAlert ? "insufficient" : "deducted"
        : hasInsufficientPapAlert ? "insufficient" : "scheduled";
    const metRequirement = !hasInsufficientPapAlert;
    return [{
      userId: member.user.id,
      characterName: member.user.eveCharacterName!,
      role: member.role,
      corporationJoinedAt: joinedAt,
      daysInCorporation,
      pap: currentAvailablePap,
      papRecords: 0,
      remainingPap: deductionShortfallPap,
      metRequirement,
      settledDeductionPap,
      currentAvailablePap,
      requiredDeductionPap: minimumPap,
      deductionShortfallPap,
      hasInsufficientPapAlert,
      deductionStatus,
    }];
  }).sort((left, right) => {
    if (left.metRequirement !== right.metRequirement) return left.metRequirement ? 1 : -1;
    if (left.deductionShortfallPap !== right.deductionShortfallPap) return right.deductionShortfallPap - left.deductionShortfallPap;
    return left.characterName.localeCompare(right.characterName);
  });
  const meetingRequirement = eligibleMembers.filter((member) => member.metRequirement).length;

  res.json({
    month: period.month,
    periodStart: period.start,
    periodEnd: period.end,
    evaluatedAt: period.evaluatedAt,
    eligibilityDays: ACTIVITY_ELIGIBILITY_DAYS,
    minimumPap,
    configuredMinimumPap: minimumPap,
    totalEligible: eligibleMembers.length,
    meetingRequirement,
    belowRequirement: eligibleMembers.length - meetingRequirement,
    settlement: {
      status: settlementStatus,
      settledAt: settlement?.createdAt ?? null,
      eligibleMemberCount: settlement?.eligibleMemberCount ?? null,
      totalDeductedPap: settlement?.totalDeductedPap ?? null,
      successfulDeductionCount: settlement ? meetingRequirement : null,
      insufficientPapCount: settlement ? eligibleMembers.length - meetingRequirement : null,
    },
    members: eligibleMembers,
  });
});

router.patch("/activity/settings", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const requestedMinimumPap = Number(req.body.minimumPap);
  if (requestedMinimumPap !== ACTIVITY_MONTHLY_PAP_DEDUCTION) {
    res.status(400).json({ error: "The monthly activity deduction is fixed at 2 PAP" });
    return;
  }
  const [corporation] = await db.update(corporationsTable).set({
    activityMinimumPap: ACTIVITY_MONTHLY_PAP_DEDUCTION,
  }).where(eq(corporationsTable.id, req.tenant!.corporation.id)).returning();
  res.json({ minimumPap: corporation.activityMinimumPap, eligibilityDays: ACTIVITY_ELIGIBILITY_DAYS });
});

router.get("/activity/new-members", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  try {
    res.json(await getRecentUnboundMemberAudit(corporationId));
  } catch (error) {
    const connection = await getCorporationRosterConnection(corporationId);
    res.status(502).json({
      error: error instanceof Error ? error.message : "Corporation roster audit failed",
      connection,
    });
  }
});

router.get("/activity/new-members/connect", (req: Request, res: Response): void => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const state = generateOauthState();
  req.session.rosterLinkCorporationId = req.tenant!.corporation.id;
  req.session.economyLinkCorporationId = undefined;
  req.session.structuresLinkCorporationId = undefined;
  req.session.linkingUserId = undefined;
  req.session.eveOauthState = state;
  req.session.eveOauthFlow = "roster";
  req.session.save((error) => {
    if (error) {
      res.status(500).json({ error: "Unable to start corporation roster authorization" });
      return;
    }
    res.redirect(getCorporationRosterAuthorizationUrl(getCallbackUrl(req), state));
  });
});

export default router;
