import assert from "node:assert/strict";
import test from "node:test";
import { resolveDiplomacyLifecycle } from "./diplomacy-management";

test("assigning a submitted diplomacy case accepts it automatically", () => {
  const now = new Date("2026-09-06T00:00:00Z");
  assert.deepEqual(resolveDiplomacyLifecycle({
    currentStatus: "submitted",
    assignment: "self",
    currentResolvedAt: null,
    currentClosedAt: null,
    now,
  }), { status: "accepted", resolvedAt: null, closedAt: null });
});

test("terminal timestamps are set and cleared when a case is reopened", () => {
  const now = new Date("2026-09-06T00:00:00Z");
  assert.deepEqual(resolveDiplomacyLifecycle({
    currentStatus: "investigating",
    requestedStatus: "resolved",
    currentResolvedAt: null,
    currentClosedAt: null,
    now,
  }), { status: "resolved", resolvedAt: now, closedAt: null });
  assert.deepEqual(resolveDiplomacyLifecycle({
    currentStatus: "closed",
    requestedStatus: "investigating",
    currentResolvedAt: now,
    currentClosedAt: now,
    now,
  }), { status: "investigating", resolvedAt: null, closedAt: null });
});
