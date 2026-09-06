export const DIPLOMACY_STATUSES = [
  "submitted",
  "accepted",
  "investigating",
  "waiting",
  "resolved",
  "rejected",
  "closed",
] as const;

export type DiplomacyStatus = (typeof DIPLOMACY_STATUSES)[number];

export function isDiplomacyStatus(value: unknown): value is DiplomacyStatus {
  return typeof value === "string"
    && DIPLOMACY_STATUSES.includes(value as DiplomacyStatus);
}

export function resolveDiplomacyLifecycle({
  currentStatus,
  requestedStatus,
  assignment,
  currentResolvedAt,
  currentClosedAt,
  now,
}: {
  currentStatus: DiplomacyStatus;
  requestedStatus?: DiplomacyStatus;
  assignment?: "self" | "unassigned";
  currentResolvedAt: Date | null;
  currentClosedAt: Date | null;
  now: Date;
}) {
  const status = requestedStatus
    ?? (assignment === "self" && currentStatus === "submitted" ? "accepted" : currentStatus);
  const resolvedAt = status === "resolved" || status === "rejected"
    ? currentResolvedAt ?? now
    : null;
  const closedAt = status === "closed" ? currentClosedAt ?? now : null;

  return { status, resolvedAt, closedAt };
}
