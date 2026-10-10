import assert from "node:assert/strict";
import test from "node:test";
import { buildActivityReport, type ActivityReportMemberInput, type ActivityReportSettlementInput } from "./activity-report";
import { countConsecutiveInsufficientActivityMonths, previousActivityMonth } from "./activity-rules";

const now = new Date("2026-10-10T00:00:00Z");
const member: ActivityReportMemberInput = {
  userId: 1,
  characterName: "测试成员",
  role: "member",
  corporationJoinedAt: new Date("2026-01-01T00:00:00Z"),
  currentAvailablePap: 0,
  membershipStatus: "member",
};
function settlement(month: string, id: number): ActivityReportSettlementInput {
  const [year, number] = month.split("-").map(Number);
  return { id, month, periodEnd: new Date(Date.UTC(year, number, 1)), createdAt: new Date(Date.UTC(year, number, 1)), eligibleMemberCount: 1, totalDeductedPap: 0 };
}
function report(amounts: [string, number | null][], selectedMonth = "2026-10", members = [member]) {
  const [year, month] = selectedMonth.split("-").map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 1));
  const settlements = amounts.map(([month], index) => settlement(month, index + 1));
  return buildActivityReport({
    period: { month: selectedMonth, start, end, evaluatedAt: now < end ? now : new Date(end.getTime() - 1) },
    now,
    deductionStartedAt: new Date("2026-01-01T00:00:00Z"),
    eligibilityDays: 60,
    members,
    settlements,
    deductions: amounts.flatMap(([, amount], index) => amount === null ? [] : [{ settlementId: index + 1, userId: 1, amount }]),
  });
}

test("current-month shortage is only a forecast and never immediately alerts", () => {
  const result = report([]);
  assert.equal(result.alertThresholdMonths, 3);
  assert.equal(result.alertWindow, "consecutive_completed_months");
  assert.equal(result.members[0]!.hasInsufficientPapAlert, false);
  assert.equal(result.members[0]!.currentMonthHasShortfall, true);
  assert.equal(result.members[0]!.deductionStatus, "scheduled");
  assert.equal(result.members[0]!.consecutiveInsufficientMonths, 0);
  assert.equal(result.belowRequirement, 0);
});

test("one or two completed shortage months do not trigger an alert", () => {
  for (const amounts of [[["2026-09", 0]], [["2026-08", 1.5], ["2026-09", 0]]] as [string, number][][]) {
    const result = report(amounts);
    assert.equal(result.members[0]!.hasInsufficientPapAlert, false);
    assert.equal(result.members[0]!.consecutiveInsufficientMonths, amounts.length);
    assert.equal(result.meetingRequirement, 1);
  }
});

test("three completed consecutive insufficient months alert even when current balance has recovered", () => {
  const result = report([["2026-07", 1], ["2026-08", 1.5], ["2026-09", 0]], "2026-10", [{ ...member, currentAvailablePap: 100 }]);
  assert.equal(result.members[0]!.consecutiveInsufficientMonths, 3);
  assert.equal(result.members[0]!.hasInsufficientPapAlert, true);
  assert.equal(result.members[0]!.currentMonthHasShortfall, false);
  assert.equal(result.members[0]!.alertAnchorMonth, "2026-09");
  assert.equal(result.belowRequirement, 1);
});

test("a completed sufficient month resets the shortage streak", () => {
  const result = report([["2026-06", 0], ["2026-07", 0], ["2026-08", 2], ["2026-09", 0]]);
  assert.equal(result.members[0]!.consecutiveInsufficientMonths, 1);
  assert.equal(result.members[0]!.hasInsufficientPapAlert, false);
});

test("a missing settlement is unknown and breaks the streak", () => {
  const result = report([["2026-06", 0], ["2026-07", 0], ["2026-09", 0]]);
  assert.equal(result.members[0]!.consecutiveInsufficientMonths, 1);
});

test("a missing personal deduction is not treated as a zero deduction", () => {
  const result = report([["2026-07", 0], ["2026-08", 0], ["2026-09", null]], "2026-09");
  assert.equal(result.members[0]!.settledDeductionPap, null);
  assert.equal(result.members[0]!.settlementRecorded, false);
  assert.equal(result.members[0]!.deductionStatus, "pending");
  assert.equal(result.members[0]!.deductionShortfallPap, 0);
  assert.equal(result.members[0]!.consecutiveInsufficientMonths, 0);
  assert.equal(result.settlement.insufficientPapCount, 0);
});

test("historical report anchors to the selected completed month and not later results", () => {
  const result = report([["2026-06", 0], ["2026-07", 0], ["2026-08", 0], ["2026-09", 2]], "2026-08");
  assert.equal(result.members[0]!.hasInsufficientPapAlert, true);
  assert.equal(result.members[0]!.alertAnchorMonth, "2026-08");
  assert.equal(result.members[0]!.settledDeductionPap, 0);
  assert.equal(result.members[0]!.deductionStatus, "insufficient");
  assert.equal(result.members[0]!.currentMonthHasShortfall, false);
});

test("historical one-month shortage remains visible as observation without an alert", () => {
  const result = report([["2026-09", 1.25]], "2026-09");
  assert.equal(result.members[0]!.hasInsufficientPapAlert, false);
  assert.equal(result.members[0]!.selectedMonthHasShortfall, true);
  assert.equal(result.members[0]!.deductionShortfallPap, 0.75);
  assert.equal(result.members[0]!.deductionStatus, "insufficient");
  assert.equal(result.settlement.insufficientPapCount, 1);
  assert.equal(result.belowRequirement, 0);
});

test("an unsettled latest completed month cannot reuse an older three-month streak", () => {
  const result = report([["2026-06", 0], ["2026-07", 0], ["2026-08", 0]]);
  assert.equal(result.members[0]!.consecutiveInsufficientMonths, 0);
  assert.equal(result.members[0]!.hasInsufficientPapAlert, false);
});

test("future or in-progress settlements do not count toward the completed-month streak", () => {
  const result = report([["2026-08", 0], ["2026-09", 0], ["2026-10", 0]]);
  assert.equal(result.members[0]!.consecutiveInsufficientMonths, 2);
  assert.equal(result.members[0]!.settlementRecorded, false);
  assert.equal(result.members[0]!.hasInsufficientPapAlert, false);
});

test("departed main characters never appear in PAP reports or warnings", () => {
  const result = report([["2026-07", 0], ["2026-08", 0], ["2026-09", 0]], "2026-10", [{ ...member, membershipStatus: "departed" }]);
  assert.equal(result.totalEligible, 0);
  assert.deepEqual(result.members, []);
  assert.equal(result.belowRequirement, 0);
});

test("unknown membership remains conservative and 60-day PAP eligibility is unchanged", () => {
  const result = report([], "2026-10", [
    { ...member, membershipStatus: "unknown" },
    { ...member, userId: 2, corporationJoinedAt: new Date("2026-09-01T00:00:00Z") },
    { ...member, userId: 3, corporationJoinedAt: null },
  ]);
  assert.equal(result.totalEligible, 1);
  assert.equal(result.members[0]!.userId, 1);
});

test("all consecutive completed shortage months are counted across year boundaries", () => {
  assert.equal(previousActivityMonth("2026-01"), "2025-12");
  assert.equal(countConsecutiveInsufficientActivityMonths({
    anchorMonth: "2026-01",
    settledMonths: new Set(["2026-01", "2025-12", "2025-11", "2025-10"]),
    deductedPapByMonth: new Map([["2026-01", 0], ["2025-12", 1], ["2025-11", 1], ["2025-10", 0]]),
  }), 4);
});

test("invalid recorded deductions cannot manufacture a shortage", () => {
  assert.equal(countConsecutiveInsufficientActivityMonths({ anchorMonth: "2026-09", settledMonths: new Set(["2026-09"]), deductedPapByMonth: new Map([["2026-09", Number.NaN]]) }), 0);
  assert.equal(countConsecutiveInsufficientActivityMonths({ anchorMonth: "2026-09", settledMonths: new Set(["2026-09"]), deductedPapByMonth: new Map([["2026-09", -2]]) }), 0);
  const result = report([["2026-07", 0], ["2026-08", 0], ["2026-09", -2]], "2026-09");
  assert.equal(result.members[0]!.settlementRecorded, false);
  assert.equal(result.members[0]!.hasInsufficientPapAlert, false);
});
