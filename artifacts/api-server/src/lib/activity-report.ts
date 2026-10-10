import {
  ACTIVITY_MONTHLY_PAP_DEDUCTION,
  ACTIVITY_PAP_ALERT_THRESHOLD_MONTHS,
  calculateActivityPapDeduction,
  countConsecutiveInsufficientActivityMonths,
  previousActivityMonth,
} from "./activity-rules";

const DAY_MS = 24 * 60 * 60 * 1_000;

export type ActivityReportMemberInput = {
  userId: number;
  characterName: string;
  role: "member" | "fc" | "admin" | "controller";
  corporationJoinedAt: Date | null;
  currentAvailablePap: number;
  membershipStatus: "unknown" | "member" | "departed";
};

export type ActivityReportSettlementInput = {
  id: number;
  month: string;
  periodEnd: Date;
  createdAt: Date;
  eligibleMemberCount: number;
  totalDeductedPap: number;
};

export type ActivityReportDeductionInput = { settlementId: number; userId: number; amount: number };

export function buildActivityReport(input: {
  period: { month: string; start: Date; end: Date; evaluatedAt: Date };
  now: Date;
  deductionStartedAt: Date;
  eligibilityDays: number;
  members: ActivityReportMemberInput[];
  settlements: ActivityReportSettlementInput[];
  deductions: ActivityReportDeductionInput[];
}) {
  const { period, now } = input;
  // Even an unexpectedly present future settlement cannot create a completed-month warning.
  const completedSettlements = input.settlements.filter((row) => row.periodEnd.getTime() <= now.getTime());
  const settlement = completedSettlements.find((row) => row.month === period.month);
  const settlementMonthById = new Map(completedSettlements.map((row) => [row.id, row.month]));
  const settledMonths = new Set(completedSettlements.map((row) => row.month));
  const isCurrentMonth = period.end.getTime() > now.getTime();
  const alertAnchorMonth = isCurrentMonth ? previousActivityMonth(period.month) : period.month;
  const selectedDeductionByUser = new Map<number, number>();
  const deductionByUserMonth = new Map<number, Map<string, number>>();
  for (const row of input.deductions) {
    const month = settlementMonthById.get(row.settlementId);
    if (!month || !Number.isFinite(row.amount) || row.amount < 0) continue;
    if (month === period.month) selectedDeductionByUser.set(row.userId, row.amount);
    let months = deductionByUserMonth.get(row.userId);
    if (!months) {
      months = new Map();
      deductionByUserMonth.set(row.userId, months);
    }
    months.set(month, row.amount);
  }
  const settlementStatus = settlement
    ? "settled"
    : period.end.getTime() <= input.deductionStartedAt.getTime()
      ? "not_applicable"
      : isCurrentMonth ? "scheduled" : "pending";

  const members = input.members.flatMap((member) => {
    if (member.membershipStatus === "departed" || !member.corporationJoinedAt) return [];
    const daysInCorporation = Math.max(0, Math.floor((period.evaluatedAt.getTime() - member.corporationJoinedAt.getTime()) / DAY_MS));
    if (daysInCorporation < input.eligibilityDays) return [];

    const settledDeductionPap = selectedDeductionByUser.get(member.userId) ?? null;
    const settlementRecorded = settledDeductionPap !== null;
    const currentMonthHasShortfall = isCurrentMonth && settlementStatus !== "not_applicable"
      && calculateActivityPapDeduction(member.currentAvailablePap).hasInsufficientPap;
    const selectedMonthHasShortfall = settlementRecorded
      && calculateActivityPapDeduction(settledDeductionPap).hasInsufficientPap;
    const deductionShortfallPap = settlementRecorded
      ? calculateActivityPapDeduction(settledDeductionPap).shortfallPap
      : currentMonthHasShortfall ? calculateActivityPapDeduction(member.currentAvailablePap).shortfallPap : 0;
    const consecutiveInsufficientMonths = countConsecutiveInsufficientActivityMonths({
      anchorMonth: alertAnchorMonth,
      settledMonths,
      deductedPapByMonth: deductionByUserMonth.get(member.userId) ?? new Map(),
    });
    const hasInsufficientPapAlert = settlementStatus !== "not_applicable"
      && consecutiveInsufficientMonths >= ACTIVITY_PAP_ALERT_THRESHOLD_MONTHS;
    const deductionStatus = settlementStatus === "not_applicable"
      ? "not_applicable"
      : settlementRecorded
        ? selectedMonthHasShortfall ? "insufficient" : "deducted"
        : isCurrentMonth ? "scheduled" : "pending";
    return [{
      userId: member.userId,
      characterName: member.characterName,
      role: member.role,
      corporationJoinedAt: member.corporationJoinedAt,
      daysInCorporation,
      pap: member.currentAvailablePap,
      papRecords: 0,
      remainingPap: deductionShortfallPap,
      metRequirement: !hasInsufficientPapAlert,
      settledDeductionPap,
      currentAvailablePap: member.currentAvailablePap,
      requiredDeductionPap: ACTIVITY_MONTHLY_PAP_DEDUCTION,
      deductionShortfallPap,
      hasInsufficientPapAlert,
      deductionStatus,
      consecutiveInsufficientMonths,
      currentMonthHasShortfall,
      selectedMonthHasShortfall,
      alertAnchorMonth,
      settlementRecorded,
    }];
  }).sort((left, right) => {
    if (left.hasInsufficientPapAlert !== right.hasInsufficientPapAlert) return left.hasInsufficientPapAlert ? -1 : 1;
    if (left.consecutiveInsufficientMonths !== right.consecutiveInsufficientMonths) return right.consecutiveInsufficientMonths - left.consecutiveInsufficientMonths;
    if (left.deductionShortfallPap !== right.deductionShortfallPap) return right.deductionShortfallPap - left.deductionShortfallPap;
    return left.characterName.localeCompare(right.characterName);
  });
  const belowRequirement = members.filter((member) => member.hasInsufficientPapAlert).length;
  return {
    month: period.month,
    periodStart: period.start,
    periodEnd: period.end,
    evaluatedAt: period.evaluatedAt,
    eligibilityDays: input.eligibilityDays,
    minimumPap: ACTIVITY_MONTHLY_PAP_DEDUCTION,
    configuredMinimumPap: ACTIVITY_MONTHLY_PAP_DEDUCTION,
    alertThresholdMonths: ACTIVITY_PAP_ALERT_THRESHOLD_MONTHS,
    alertWindow: "consecutive_completed_months" as const,
    totalEligible: members.length,
    meetingRequirement: members.length - belowRequirement,
    belowRequirement,
    settlement: {
      status: settlementStatus,
      settledAt: settlement?.createdAt ?? null,
      eligibleMemberCount: settlement?.eligibleMemberCount ?? null,
      totalDeductedPap: settlement?.totalDeductedPap ?? null,
      successfulDeductionCount: settlement ? members.filter((member) => member.settlementRecorded && !member.selectedMonthHasShortfall).length : null,
      insufficientPapCount: settlement ? members.filter((member) => member.selectedMonthHasShortfall).length : null,
    },
    members,
  };
}
