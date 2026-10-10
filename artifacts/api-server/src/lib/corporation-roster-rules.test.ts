import assert from "node:assert/strict";
import test from "node:test";
import { buildUnboundCorporationMemberAudit } from "./corporation-roster-rules";

const now = new Date("2026-10-10T00:00:00Z");
const audit = (tracking: Parameters<typeof buildUnboundCorporationMemberAudit>[0]["tracking"], boundIds = new Set<number>()) => buildUnboundCorporationMemberAudit({ tracking, boundIds, now, windowDays: 60 });

test("all unbound current corporation members alert regardless of join age", () => {
  const result = audit([{ character_id: 1, start_date: "2020-01-01T00:00:00Z" }, { character_id: 2, start_date: "2026-10-01T00:00:00Z" }]);
  assert.equal(result.auditScope, "all");
  assert.equal(result.windowDays, 60);
  assert.equal(result.reviewedMemberCount, 2);
  assert.equal(result.recentMemberCount, 1);
  assert.equal(result.unboundMemberCount, 2);
  assert.deepEqual(result.members.map((member) => member.characterId), [2, 1]);
});

test("missing, invalid, and future join dates remain reviewable instead of silently disappearing", () => {
  const result = audit([{ character_id: 1 }, { character_id: 2, start_date: "not-a-date" }, { character_id: 3, start_date: "2026-11-01T00:00:00Z" }]);
  assert.equal(result.reviewedMemberCount, 3);
  assert.equal(result.unknownJoinDateCount, 3);
  assert.equal(result.unboundMemberCount, 3);
  for (const member of result.members) {
    assert.equal(member.corporationJoinedAt, null);
    assert.equal(member.daysInCorporation, null);
    assert.equal(member.joinDateKnown, false);
  }
});

test("bound IDs only suppress the same current corporation character", () => {
  const result = audit([{ character_id: 1 }, { character_id: 2 }], new Set([1, 999]));
  assert.equal(result.reviewedMemberCount, 2);
  assert.equal(result.unboundMemberCount, 1);
  assert.equal(result.members[0]!.characterId, 2);
});

test("duplicate and invalid roster identifiers cannot inflate alerts", () => {
  const result = audit([{ character_id: 1 }, { character_id: 1, start_date: "2026-10-01T00:00:00Z" }, { character_id: -1 }, { character_id: 1.5 }, { character_id: Number.NaN }]);
  assert.equal(result.reviewedMemberCount, 1);
  assert.equal(result.unboundMemberCount, 1);
  assert.equal(result.members[0]!.joinDateKnown, true);
});

test("resolved names are used with a safe ID fallback", () => {
  const result = buildUnboundCorporationMemberAudit({ tracking: [{ character_id: 1 }, { character_id: 2 }], boundIds: new Set(), names: new Map([[1, "军团成员"]]), now, windowDays: 60 });
  assert.ok(result.members.some((member) => member.characterName === "军团成员"));
  assert.ok(result.members.some((member) => member.characterName === "Character 2"));
});
