import {
  activityMonthlyDeductionsTable,
  activityMonthlySettlementsTable,
  corporationMembershipsTable,
  corporationsTable,
  db,
  papRecordsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { availablePap, canonicalPapBalance, normalizePap, setPapBalance } from "./pap-balance";
import { writePapLedger } from "./pap-ledger";

export const ACTIVITY_ELIGIBILITY_DAYS = 60;
export const ACTIVITY_SETTLEMENT_SWEEP_INTERVAL_MS = 15 * 60 * 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;

type MonthPeriod = {
  month: string;
  start: Date;
  end: Date;
};

export type ActivitySettlementSweepResult = {
  settlementsCreated: number;
  membersSettled: number;
  totalPapDeducted: number;
};

function monthPeriod(year: number, zeroBasedMonth: number): MonthPeriod {
  const start = new Date(Date.UTC(year, zeroBasedMonth, 1));
  const end = new Date(Date.UTC(year, zeroBasedMonth + 1, 1));
  return {
    month: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
    start,
    end,
  };
}

function dueMonthPeriods(startedAt: Date, now: Date): MonthPeriod[] {
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const periods: MonthPeriod[] = [];
  let cursor = monthPeriod(startedAt.getUTCFullYear(), startedAt.getUTCMonth());
  while (cursor.start.getTime() < currentMonthStart.getTime()) {
    if (cursor.end.getTime() > startedAt.getTime() && cursor.end.getTime() <= now.getTime()) {
      periods.push(cursor);
    }
    cursor = monthPeriod(cursor.end.getUTCFullYear(), cursor.end.getUTCMonth());
  }
  return periods;
}

async function settleCorporationMonth(
  corporationId: number,
  period: MonthPeriod,
): Promise<{ membersSettled: number; totalPapDeducted: number } | null> {
  return db.transaction(async (tx) => {
    const monthLockKey = Number(period.month.replace("-", ""));
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${corporationId}::integer, ${monthLockKey}::integer)`);

    const [existing] = await tx
      .select({ id: activityMonthlySettlementsTable.id })
      .from(activityMonthlySettlementsTable)
      .where(and(
        eq(activityMonthlySettlementsTable.corporationId, corporationId),
        eq(activityMonthlySettlementsTable.month, period.month),
      ));
    if (existing) return null;

    const [corporation] = await tx
      .select({
        minimumPap: corporationsTable.activityMinimumPap,
        deductionStartedAt: corporationsTable.activityDeductionStartedAt,
      })
      .from(corporationsTable)
      .where(and(
        eq(corporationsTable.id, corporationId),
        eq(corporationsTable.isActive, true),
        eq(corporationsTable.papEnabled, true),
      ));
    if (!corporation || corporation.deductionStartedAt.getTime() >= period.end.getTime()) {
      return null;
    }

    const minimumPap = normalizePap(Number(corporation.minimumPap));
    const evaluatedAt = new Date(period.end.getTime() - 1);
    const eligibilityCutoff = new Date(evaluatedAt.getTime() - ACTIVITY_ELIGIBILITY_DAYS * DAY_MS);
    const members = await tx
      .select({ userId: usersTable.id })
      .from(corporationMembershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, corporationMembershipsTable.userId))
      .where(and(
        eq(corporationMembershipsTable.corporationId, corporationId),
        eq(usersTable.corporationId, corporationId),
        isNotNull(usersTable.eveCharacterId),
        isNotNull(usersTable.eveCharacterName),
        isNotNull(usersTable.corporationJoinedAt),
        lte(usersTable.corporationJoinedAt, eligibilityCutoff),
      ))
      .orderBy(usersTable.id);

    const [settlement] = await tx
      .insert(activityMonthlySettlementsTable)
      .values({
        corporationId,
        month: period.month,
        periodStart: period.start,
        periodEnd: period.end,
        minimumPap,
        eligibleMemberCount: members.length,
        totalDeductedPap: 0,
      })
      .returning({ id: activityMonthlySettlementsTable.id });

    let totalPapDeducted = 0;
    for (const member of members) {
      const [user] = await tx
        .select({
          id: usersTable.id,
          eveCharacterName: usersTable.eveCharacterName,
          redeemablePap: usersTable.redeemablePap,
          lockedPap: usersTable.lockedPap,
        })
        .from(usersTable)
        .where(and(
          eq(usersTable.id, member.userId),
          eq(usersTable.corporationId, corporationId),
        ))
        .for("update");
      if (!user) {
        throw new Error(`Eligible activity member ${member.userId} changed corporation during settlement`);
      }

      const redeemablePapBefore = canonicalPapBalance(user.redeemablePap);
      const deductedPap = normalizePap(Math.min(availablePap(redeemablePapBefore, user.lockedPap), minimumPap));
      const redeemablePapAfter = canonicalPapBalance(redeemablePapBefore - deductedPap);
      await tx
        .update(usersTable)
        .set(setPapBalance(redeemablePapAfter, user.lockedPap))
        .where(and(
          eq(usersTable.id, user.id),
          eq(usersTable.corporationId, corporationId),
        ));

      let papRecordId: number | null = null;
      if (deductedPap > 0) {
        const [papRecord] = await tx
          .insert(papRecordsTable)
          .values({
            corporationId,
            userId: user.id,
            amount: -deductedPap,
            type: "activity_deduction",
            reason: `Monthly activity minimum deduction · ${period.month}`,
            createdAt: period.end,
          })
          .returning({ id: papRecordsTable.id });
        papRecordId = papRecord.id;
        await writePapLedger(tx, {
          corporationId,
          userId: user.id,
          userName: user.eveCharacterName ?? `User ${user.id}`,
          amount: -deductedPap,
          type: "activity_deduction",
          balanceAfter: redeemablePapAfter,
          lockedAfter: user.lockedPap,
          reason: `Monthly activity minimum deduction · ${period.month}`,
          createdAt: period.end,
        });
      }

      await tx.insert(activityMonthlyDeductionsTable).values({
        corporationId,
        settlementId: settlement.id,
        userId: user.id,
        papRecordId,
        amount: deductedPap,
        totalPapBefore: redeemablePapBefore,
        totalPapAfter: redeemablePapAfter,
        redeemablePapBefore,
        redeemablePapAfter,
      });
      totalPapDeducted = normalizePap(totalPapDeducted + deductedPap);
    }

    await tx
      .update(activityMonthlySettlementsTable)
      .set({ totalDeductedPap: totalPapDeducted })
      .where(eq(activityMonthlySettlementsTable.id, settlement.id));

    return { membersSettled: members.length, totalPapDeducted };
  });
}

export async function settleDueActivityMonths(now = new Date()): Promise<ActivitySettlementSweepResult> {
  const corporations = await db
    .select({
      id: corporationsTable.id,
      deductionStartedAt: corporationsTable.activityDeductionStartedAt,
    })
    .from(corporationsTable)
    .where(and(
      eq(corporationsTable.isActive, true),
      eq(corporationsTable.papEnabled, true),
    ));

  const result: ActivitySettlementSweepResult = {
    settlementsCreated: 0,
    membersSettled: 0,
    totalPapDeducted: 0,
  };
  for (const corporation of corporations) {
    const existing = await db
      .select({ month: activityMonthlySettlementsTable.month })
      .from(activityMonthlySettlementsTable)
      .where(eq(activityMonthlySettlementsTable.corporationId, corporation.id));
    const settledMonths = new Set(existing.map((row) => row.month));
    for (const period of dueMonthPeriods(corporation.deductionStartedAt, now)) {
      if (settledMonths.has(period.month)) continue;
      const settlement = await settleCorporationMonth(corporation.id, period);
      if (!settlement) continue;
      result.settlementsCreated += 1;
      result.membersSettled += settlement.membersSettled;
      result.totalPapDeducted = normalizePap(result.totalPapDeducted + settlement.totalPapDeducted);
    }
  }
  return result;
}
