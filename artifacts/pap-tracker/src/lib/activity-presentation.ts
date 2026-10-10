export interface ActivityMemberPresentation {
  deductionStatus: "not_applicable" | "scheduled" | "pending" | "deducted" | "insufficient";
  hasInsufficientPapAlert: boolean;
  settlementRecorded: boolean;
  selectedMonthHasShortfall: boolean;
  currentMonthHasShortfall: boolean;
}

export type ActivityPresentationState =
  | "not_applicable"
  | "alert"
  | "observing"
  | "forecast_shortfall"
  | "deducted"
  | "pending"
  | "scheduled";

/** Alert decisions belong to the server; forecasts and one/two-month observations are never alerts. */
export function activityPresentationState(member: ActivityMemberPresentation): ActivityPresentationState {
  if (member.deductionStatus === "not_applicable") return "not_applicable";
  if (member.hasInsufficientPapAlert) return "alert";
  if (member.settlementRecorded && member.selectedMonthHasShortfall) return "observing";
  if (!member.settlementRecorded && member.currentMonthHasShortfall) return "forecast_shortfall";
  if (member.settlementRecorded && member.deductionStatus === "deducted") return "deducted";
  if (member.deductionStatus === "pending") return "pending";
  return "scheduled";
}

export function rosterJoinDateLabel(
  joinedAt: string | null | undefined,
  joinDateKnown: boolean,
  zh: boolean,
): string {
  if (!joinDateKnown || !joinedAt || !Number.isFinite(Date.parse(joinedAt))) {
    return zh ? "未知" : "Unknown";
  }
  return new Date(joinedAt).toLocaleString(zh ? "zh-CN" : "en-GB");
}

export function rosterDaysLabel(
  days: number | null | undefined,
  joinDateKnown: boolean,
  zh: boolean,
): string {
  if (!joinDateKnown || days === null || days === undefined || !Number.isFinite(days) || days < 0) {
    return zh ? "未知" : "Unknown";
  }
  return zh ? `${days} 天` : `${days} days`;
}

export function rosterHasCompletedReview(data: {
  reviewedAt: string | null;
  reviewedMemberCount: number;
  connection: { status: "connected" | "error" } | null;
}): boolean {
  return data.connection?.status === "connected"
    && !!data.reviewedAt
    && Number.isFinite(Date.parse(data.reviewedAt))
    && data.reviewedMemberCount > 0;
}
