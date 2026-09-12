export type SystemMapRisk = "safe" | "info" | "warning" | "danger" | "critical";

export type SystemMapRiskEvent = {
  source: string;
  severity: Exclude<SystemMapRisk, "safe">;
  occurredAt: string;
  expiresAt: string | null;
};

export type SystemMapRiskMonitor = {
  burstThreshold: number;
  burstWindowMinutes: number;
};

const RISK_RANK: Record<SystemMapRisk, number> = {
  safe: 0,
  info: 1,
  warning: 2,
  danger: 3,
  critical: 4,
};

/** Mirrors dashboard risk while allowing expired reports to clear locally. */
export function getSystemMapRisk(
  events: readonly SystemMapRiskEvent[],
  monitor: SystemMapRiskMonitor | null,
  now = Date.now(),
): SystemMapRisk {
  const activeEvents = events.filter(
    (event) => event.expiresAt === null || Date.parse(event.expiresAt) > now,
  );
  let risk: SystemMapRisk = "safe";
  for (const event of activeEvents) {
    if (RISK_RANK[event.severity] > RISK_RANK[risk]) risk = event.severity;
  }

  if (
    !monitor ||
    !Number.isFinite(monitor.burstThreshold) ||
    monitor.burstThreshold <= 0 ||
    !Number.isFinite(monitor.burstWindowMinutes) ||
    monitor.burstWindowMinutes <= 0
  ) {
    return risk;
  }

  const windowStart = now - monitor.burstWindowMinutes * 60_000;
  const recentKills = activeEvents.filter(
    (event) =>
      event.source === "killmail" &&
      Date.parse(event.occurredAt) >= windowStart,
  ).length;
  return recentKills >= monitor.burstThreshold &&
    RISK_RANK[risk] < RISK_RANK.danger
    ? "danger"
    : risk;
}
