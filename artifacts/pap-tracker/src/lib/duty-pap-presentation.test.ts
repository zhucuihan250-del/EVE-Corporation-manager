import assert from "node:assert/strict";
import test from "node:test";
import {
  DutyPapError,
  dutyPapApi,
  dutyAuthorizationErrorLabel,
  dutyPapRuleInput,
  dutyStatusLabel,
  formatDutyDuration,
  formatDutyUtc,
  isDutyCapAtLeastAward,
  isDutyFleetId,
  validateDutyPapAdmin,
  validateDutyPapMine,
  type DutyPapRule,
} from "./duty-pap-api.ts";

const rule: DutyPapRule = {
  id: 1,
  name: "External FC duty",
  eveFleetId: "1234567890123",
  currencyId: null,
  currencyName: "通用 PAP",
  minutesPerAward: 60,
  awardAmount: "0.000001",
  dailyCap: "2.000000",
  solarSystemIds: [30000142],
  shipTypeIds: [587],
  requireUndocked: true,
  enabled: false,
  version: 0,
  solarSystems: [{ id: 30000142, name: "Jita" }],
  shipTypes: [{ id: 587, name: "Rifter" }],
  today: {
    eligibleSeconds: 30,
    totalEligibleSeconds: 120,
    awardCount: 1,
    paidAmount: "0.000001",
  },
};
const mine = () => ({
  connection: null,
  characters: [{ id: 7, eveCharacterId: 12345, name: "Pilot" }],
  rules: [structuredClone(rule)],
  awards: [],
  pollIntervalSeconds: 60,
  day: "2026-10-04",
  timezone: "UTC",
});
const admin = () => ({
  rules: [structuredClone(rule)],
  currencies: [{ id: 2, name: "Custom", issuanceEnabled: false }],
  connections: [],
  awards: [],
});

test("fleet IDs stay strings and reject unsafe integers, zero, signs and exponents", () => {
  for (const value of ["1", "1234567890123", "9007199254740991"])
    assert.equal(isDutyFleetId(value), true, value);
  for (const value of [
    "",
    "0",
    "01",
    "-1",
    "1.0",
    "1e12",
    " 1",
    "9007199254740992",
    "12345678901234567",
  ])
    assert.equal(isDutyFleetId(value), false, value);
});
test("daily cap comparison preserves micro PAP precision and rejects invalid formats", () => {
  assert.equal(isDutyCapAtLeastAward("1000000.000000", "999999.999999"), true);
  assert.equal(isDutyCapAtLeastAward("0.000001", "0.000001"), true);
  assert.equal(isDutyCapAtLeastAward("1.000000", "1.000001"), false);
  assert.equal(isDutyCapAtLeastAward("999999.999999", "1000000.000000"), false);
  for (const cap of [
    "NaN",
    "1e6",
    "0.0000001",
    "1,000",
    "-1",
    "1.",
    " 1",
    "1".repeat(41),
  ])
    assert.equal(isDutyCapAtLeastAward(cap, "1"), false, cap);
});
test("duration formatting floors valid seconds and never displays NaN or negative time", () => {
  assert.equal(formatDutyDuration(3599.9, true), "59 分 59 秒");
  assert.equal(formatDutyDuration(3600, false), "60m 0s");
  assert.equal(formatDutyDuration(-1, true), "0 分 0 秒");
  assert.equal(formatDutyDuration(Number.NaN, false), "0m 0s");
});
test("timestamps are explicitly UTC regardless of client timezone", () => {
  assert.equal(
    formatDutyUtc("2026-10-04T12:30:00+10:30"),
    "2026-10-04 02:00:00 UTC",
  );
  for (const value of [undefined, null, "", "invalid"])
    assert.equal(formatDutyUtc(value), "—");
});
test("all collector boundary statuses have safe Chinese and English labels", () => {
  for (const value of [
    "eligible",
    "observed",
    "daily_cap",
    "offline",
    "unavailable",
    "rate_limited",
    "stale_data",
    "not_in_fleet",
    "unrecognized_fleet",
    "wrong_system",
    "wrong_ship",
    "docked",
    "left_corporation",
    "member_unavailable",
    "module_disabled",
    "currency_paused",
    "authorization_required",
    "paused",
  ]) {
    assert.notEqual(dutyStatusLabel(value, true), "等待核验", value);
    assert.notEqual(
      dutyStatusLabel(value, false),
      "Awaiting verification",
      value,
    );
  }
  assert.equal(
    dutyStatusLabel("<script>private token</script>", true),
    "等待核验",
  );
});
test("all OAuth outcomes explain next steps without reflecting unknown input", () => {
  for (const code of [
    "duty_scopes",
    "duty_cancelled",
    "duty_character",
    "duty_changed",
    "duty_auth",
  ]) {
    assert.ok(dutyAuthorizationErrorLabel(code, true).length > 10);
    assert.ok(dutyAuthorizationErrorLabel(code, false).length > 10);
  }
  assert.equal(
    dutyAuthorizationErrorLabel("<html>SECRET</html>", true).includes("SECRET"),
    false,
  );
});
test("rule mutation payload is explicit and excludes progress, names and unknown fields", () => {
  const input = dutyPapRuleInput(rule);
  assert.deepEqual(
    Object.keys(input).sort(),
    [
      "name",
      "eveFleetId",
      "currencyId",
      "minutesPerAward",
      "awardAmount",
      "dailyCap",
      "solarSystemIds",
      "shipTypeIds",
      "requireUndocked",
      "enabled",
    ].sort(),
  );
  assert.equal(input.awardAmount, "0.000001");
  assert.equal(input.currencyId, null);
  assert.equal(input.enabled, false);
});
test("member data accepts empty or owned-authorized states and strict progress", () => {
  const data = mine();
  assert.equal(validateDutyPapMine(data), true);
  assert.equal(
    validateDutyPapMine({
      ...data,
      connection: {
        id: 1,
        characterId: 7,
        characterName: "Pilot",
        enabled: true,
        version: 2,
        hasRequiredScopes: true,
        status: "eligible",
        statusMessage: "ok",
        lastCheckedAt: "2026-10-04T00:00:00Z",
        lastObservedAt: null,
      },
    }),
    true,
  );
  assert.equal(
    validateDutyPapMine({ ...data, rules: [{ ...rule, today: undefined }] }),
    false,
  );
  assert.equal(
    validateDutyPapMine({ ...data, rules: [{ ...rule, minutesPerAward: 0 }] }),
    false,
  );
  assert.equal(
    validateDutyPapMine({
      ...data,
      rules: [{ ...rule, today: { ...rule.today, eligibleSeconds: -1 } }],
    }),
    false,
  );
});
test("malformed success bodies are rejected before page rendering", () => {
  const data = mine();
  for (const value of [
    null,
    [],
    {},
    { ...data, rules: null },
    { ...data, characters: "private" },
    { ...data, timezone: "local" },
    { ...data, awards: [{}] },
    { ...data, connection: {} },
  ])
    assert.equal(validateDutyPapMine(value), false);
  assert.equal(validateDutyPapAdmin(admin()), true);
  assert.equal(
    validateDutyPapAdmin({
      ...admin(),
      connections: [
        {
          userId: 1,
          userName: "Pilot",
          characterName: "Pilot",
          enabled: true,
          status: "eligible",
          statusMessage: "ok",
          lastCheckedAt: null,
        },
      ],
    }),
    true,
  );
  for (const value of [
    null,
    [],
    {},
    { ...admin(), currencies: [{}] },
    { ...admin(), connections: [{}] },
    { ...admin(), rules: [{ ...rule, eveFleetId: "9007199254740992" }] },
  ])
    assert.equal(validateDutyPapAdmin(value), false);
});
test("HTML, bearer and token error responses are never exposed", async () => {
  const previous = globalThis.fetch;
  try {
    for (const raw of [
      "<html>PRIVATE</html>",
      "Bearer PRIVATE",
      "access_token=PRIVATE",
      "refresh_token=PRIVATE",
      "X".repeat(1001),
    ]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify({ error: raw }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      await assert.rejects(
        dutyPapApi.mine(),
        (error: unknown) =>
          error instanceof DutyPapError &&
          !error.message.includes("PRIVATE") &&
          error.message.length < 300,
      );
    }
  } finally {
    globalThis.fetch = previous;
  }
});
test("network errors are sanitized and mutation keeps decimal strings unchanged", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      throw new TypeError("PRIVATE upstream details");
    };
    await assert.rejects(
      dutyPapApi.mine(),
      (error: unknown) =>
        error instanceof DutyPapError &&
        error.status === 0 &&
        !error.message.includes("PRIVATE"),
    );
    let sent: Record<string, unknown> | null = null;
    globalThis.fetch = async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      assert.equal(init?.credentials, "include");
      return new Response(JSON.stringify({ rule, replayed: false }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    await dutyPapApi.create({
      ...dutyPapRuleInput(rule),
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    assert.equal(sent?.awardAmount, "0.000001");
    assert.equal(sent?.dailyCap, "2.000000");
    assert.equal(sent?.enabled, false);
  } finally {
    globalThis.fetch = previous;
  }
});
test("current fleet preview returns only a verified fleet ID or a fixed safe error", async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ fleetId: "1234567890123", role: "fleet_member" }),
        { status: 200 },
      );
    assert.equal((await dutyPapApi.myFleet()).fleetId, "1234567890123");
    for (const data of [
      { fleetId: "9007199254740992", role: "fleet_member" },
      { error: "PRIVATE ESI details" },
    ]) {
      globalThis.fetch = async () =>
        new Response(JSON.stringify(data), {
          status: "error" in data ? 502 : 200,
        });
      await assert.rejects(
        dutyPapApi.myFleet(),
        (error: unknown) =>
          error instanceof DutyPapError &&
          !error.message.includes("PRIVATE") &&
          error.message.includes("当前登录角色"),
      );
    }
  } finally {
    globalThis.fetch = previous;
  }
});
