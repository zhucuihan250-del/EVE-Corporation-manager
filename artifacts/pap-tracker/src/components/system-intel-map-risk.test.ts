import assert from "node:assert/strict";
import test from "node:test";
import {
  getSystemMapRisk,
  type SystemMapRiskEvent,
} from "./system-intel-map-risk.ts";

const now = Date.parse("2026-09-12T12:00:00Z");
const monitor = { burstThreshold: 3, burstWindowMinutes: 10 };

function event(
  overrides: Partial<SystemMapRiskEvent> = {},
): SystemMapRiskEvent {
  return {
    source: "killmail",
    severity: "warning",
    occurredAt: new Date(now - 60_000).toISOString(),
    expiresAt: new Date(now + 5 * 60_000).toISOString(),
    ...overrides,
  };
}

test("no active reports produces no alert, including exact expiry", () => {
  assert.equal(getSystemMapRisk([], monitor, now), "safe");
  assert.equal(
    getSystemMapRisk(
      [
        event({ severity: "critical", expiresAt: new Date(now).toISOString() }),
        event({ expiresAt: new Date(now - 1).toISOString() }),
      ],
      monitor,
      now,
    ),
    "safe",
  );
});

test("highest active severity wins and expired severity is discarded", () => {
  assert.equal(
    getSystemMapRisk(
      [
        event({ source: "manual", severity: "info" }),
        event({ severity: "danger" }),
        event({
          severity: "critical",
          expiresAt: new Date(now - 1).toISOString(),
        }),
      ],
      monitor,
      now,
    ),
    "danger",
  );
});

test("valid killmails at the configured threshold escalate warning to danger", () => {
  const kills = [event(), event(), event()];
  assert.equal(getSystemMapRisk(kills.slice(0, 2), monitor, now), "warning");
  assert.equal(getSystemMapRisk(kills, monitor, now), "danger");
  assert.equal(
    getSystemMapRisk(kills, { ...monitor, burstThreshold: 4 }, now),
    "warning",
  );
});

test("kill window includes its exact start but excludes older and expired kills", () => {
  const windowStart = now - monitor.burstWindowMinutes * 60_000;
  const twoKills = [event(), event()];
  assert.equal(
    getSystemMapRisk(
      [...twoKills, event({ occurredAt: new Date(windowStart).toISOString() })],
      monitor,
      now,
    ),
    "danger",
  );
  assert.equal(
    getSystemMapRisk(
      [
        ...twoKills,
        event({ occurredAt: new Date(windowStart - 1).toISOString() }),
        event({ expiresAt: new Date(now).toISOString() }),
      ],
      monitor,
      now,
    ),
    "warning",
  );
});

test("manual, bridge and aggregate activity reports do not inflate kill count", () => {
  assert.equal(
    getSystemMapRisk(
      [
        event(),
        event(),
        event({ source: "manual" }),
        event({ source: "chat" }),
        event({ source: "activity" }),
      ],
      monitor,
      now,
    ),
    "warning",
  );
});

test("burst escalation never lowers an active critical alert", () => {
  assert.equal(
    getSystemMapRisk(
      [
        event(),
        event(),
        event(),
        event({ source: "manual", severity: "critical" }),
      ],
      monitor,
      now,
    ),
    "critical",
  );
});

test("unmonitored systems have no burst threshold but retain report severity", () => {
  assert.equal(
    getSystemMapRisk([event(), event(), event()], null, now),
    "warning",
  );
  assert.equal(
    getSystemMapRisk(
      [event({ source: "manual", severity: "critical" })],
      null,
      now,
    ),
    "critical",
  );
});

test("moving time clears expired reports and removes kills outside the window", () => {
  const kills = [
    event({ occurredAt: new Date(now - 9 * 60_000).toISOString() }),
    event(),
    event(),
  ];
  assert.equal(getSystemMapRisk(kills, monitor, now), "danger");
  assert.equal(getSystemMapRisk(kills, monitor, now + 2 * 60_000), "warning");
  assert.equal(getSystemMapRisk(kills, monitor, now + 5 * 60_000), "safe");
});

test("nullable expiry stays compatible and malformed dates cannot create a burst", () => {
  assert.equal(
    getSystemMapRisk(
      [event({ severity: "info", expiresAt: null })],
      monitor,
      now,
    ),
    "info",
  );
  assert.equal(
    getSystemMapRisk(
      [
        event(),
        event(),
        event({ occurredAt: "invalid" }),
        event({ expiresAt: "invalid" }),
      ],
      monitor,
      now,
    ),
    "warning",
  );
});
