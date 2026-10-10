import assert from "node:assert/strict";
import test from "node:test";
import {
  activityPresentationState,
  rosterDaysLabel,
  rosterHasCompletedReview,
  rosterJoinDateLabel,
  type ActivityMemberPresentation,
} from "./activity-presentation.ts";

const ready: ActivityMemberPresentation = {
  deductionStatus: "scheduled",
  hasInsufficientPapAlert: false,
  settlementRecorded: false,
  selectedMonthHasShortfall: false,
  currentMonthHasShortfall: false,
};

test("current month balance forecast never presents as a PAP alert", () => {
  assert.equal(activityPresentationState({ ...ready, currentMonthHasShortfall: true }), "forecast_shortfall");
});
test("one or two deficient settlements present as observation, not an alert", () => {
  assert.equal(activityPresentationState({
    ...ready, deductionStatus: "insufficient", settlementRecorded: true, selectedMonthHasShortfall: true,
  }), "observing");
});
test("server-confirmed three month alerts remain visible even if the current balance is sufficient", () => {
  assert.equal(activityPresentationState({ ...ready, hasInsufficientPapAlert: true }), "alert");
});
test("a completed full deduction and a scheduled month have distinct states", () => {
  assert.equal(activityPresentationState({ ...ready, deductionStatus: "deducted", settlementRecorded: true }), "deducted");
  assert.equal(activityPresentationState(ready), "scheduled");
});
test("a missing completed-month settlement is pending, not a shortage or completed deduction", () => {
  assert.equal(activityPresentationState({ ...ready, deductionStatus: "pending" }), "pending");
});
test("months before automatic deduction activation do not show forecast alerts", () => {
  assert.equal(activityPresentationState({ ...ready, deductionStatus: "not_applicable", currentMonthHasShortfall: true }), "not_applicable");
});
test("unknown joins never render the Unix epoch, an invented date, or an invented tenure", () => {
  for (const value of [null, undefined, "", "invalid", "2026-10-01T00:00:00Z"]) {
    assert.equal(rosterJoinDateLabel(value, false, true), "未知");
  }
  assert.equal(rosterJoinDateLabel(null, true, false), "Unknown");
  assert.notEqual(rosterJoinDateLabel("2026-10-01T00:00:00Z", true, true), "未知");
  for (const days of [null, undefined, -1, Number.NaN, 0, 120]) {
    assert.equal(rosterDaysLabel(days, false, true), "未知");
  }
  assert.equal(rosterDaysLabel(null, true, false), "Unknown");
  assert.equal(rosterDaysLabel(0, true, true), "0 天");
  assert.equal(rosterDaysLabel(120, true, false), "120 days");
});
test("missing, failed, zero-member, and incomplete roster audits cannot claim everyone is bound", () => {
  const reviewed = { reviewedAt: "2026-10-10T00:00:00Z", reviewedMemberCount: 25, connection: { status: "connected" as const } };
  assert.equal(rosterHasCompletedReview(reviewed), true);
  assert.equal(rosterHasCompletedReview({ ...reviewed, connection: null }), false);
  assert.equal(rosterHasCompletedReview({ ...reviewed, connection: { status: "error" } }), false);
  assert.equal(rosterHasCompletedReview({ ...reviewed, reviewedAt: null }), false);
  assert.equal(rosterHasCompletedReview({ ...reviewed, reviewedAt: "invalid" }), false);
  assert.equal(rosterHasCompletedReview({ ...reviewed, reviewedMemberCount: 0 }), false);
});
