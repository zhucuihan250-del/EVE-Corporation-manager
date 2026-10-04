import assert from "node:assert/strict";
import test from "node:test";
import { createDutyPapCollector, type DutyPapCollectConnection } from "./duty-pap-collector";
import { DUTY_PAP_SCOPES } from "./duty-pap-rules";
import { EveTokenRefreshError } from "./eve-sso";

const instant = new Date("2026-10-04T10:00:00Z");
const connection = (extra: Partial<DutyPapCollectConnection> = {}): DutyPapCollectConnection => ({ corporationId: 1001, userId: 2, characterId: 10, eveCharacterId: 20010, accessToken: "test-independent-access", refreshToken: "test-independent-refresh", tokenExpiry: new Date(+instant + 3_600_000), scopes: [...DUTY_PAP_SCOPES], ...extra });
function mockProvider(options: { bodies?: Record<string, unknown>; headers?: Record<string, Record<string, string>>; statuses?: Record<string, number>; response?: (path: string) => Response } = {}) {
  const calls: { path: string; method: string; authorization: string | null; tenant: string | null; body: string | null }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    const key = path.split("/").at(-1)!;
    const headers = new Headers(init?.headers);
    calls.push({ path, method: init?.method ?? "GET", authorization: headers.get("authorization"), tenant: headers.get("x-tenant"), body: typeof init?.body === "string" ? init.body : null });
    const payloads: Record<string, unknown> = { fleet: { fleet_id: 1099522222222, role: "member" }, online: { online: true }, location: { solar_system_id: 30000142 }, ship: { ship_type_id: 587 }, affiliation: [{ character_id: 20010, corporation_id: 1001 }] };
    return options.response?.(key) ?? new Response(JSON.stringify(options.bodies?.[key] ?? payloads[key]), { status: options.statuses?.[key] ?? 200, headers: { date: instant.toUTCString(), ...options.headers?.[key] } });
  };
  return { calls, collector: createDutyPapCollector({ fetchImpl, now: () => new Date(instant) }) };
}
test("read-only collector uses only own four character endpoints and one affiliation read POST", async () => {
  const f = mockProvider(), result = await f.collector.collect(connection());
  assert.equal(result.valid, true); assert.equal(result.eveFleetId, "1099522222222"); assert.equal(result.docked, false);
  assert.equal(result.evidenceAt!.toISOString(), instant.toISOString());
  assert.equal(f.calls.length, 5);
  for (const call of f.calls) {
    assert.equal(call.tenant, "tranquility"); assert.equal(call.path.includes("latest"), false);
    if (call.path === "/characters/affiliation") { assert.equal(call.method, "POST"); assert.equal(call.body, "[20010]"); assert.equal(call.authorization, null); }
    else { assert.equal(call.method, "GET"); assert.equal(call.path.startsWith("/characters/20010/"), true); assert.equal(call.authorization, "Bearer test-independent-access"); }
    assert.equal(call.path.includes("/members"), false);
  }
});
test("missing scope performs no network call and reports reauthorization rather than an eligibility failure", async () => {
  const f = mockProvider(), result = await f.collector.collect(connection({ scopes: [DUTY_PAP_SCOPES[0]] }));
  assert.equal(result.valid, false); assert.equal(result.status, "authorization_required"); assert.equal(f.calls.length, 0);
});
test("HTTP Date already origin and Age resident duration are not subtracted twice", async () => {
  const f = mockProvider({ headers: { fleet: { date: new Date(+instant - 60_000).toUTCString(), age: "60" } } });
  const result = await f.collector.collect(connection());
  assert.equal(result.valid, true); assert.equal(+result.evidenceAt!, +instant - 60_000);
});
test("freshness uses oldest current presence evidence, affiliation accepts its official one-hour cache separately", async () => {
  const f = mockProvider({ headers: { fleet: { age: "30" }, online: { age: "60" }, affiliation: { date: new Date(+instant - 3_599_000).toUTCString(), age: "3599" } } });
  const result = await f.collector.collect(connection());
  assert.equal(result.valid, true); assert.equal(+result.evidenceAt!, +instant - 60_000);
  const oldAffiliation = mockProvider({ headers: { affiliation: { age: "3601" } } });
  assert.equal((await oldAffiliation.collector.collect(connection())).status, "stale_data");
});
test("expired caches, invalid date/age and future header evidence are rejected conservatively", async () => {
  const cases: Record<string, string>[] = [{ age: "91" }, { date: "invalid" }, { age: "-1" }, { date: new Date(+instant + 6000).toUTCString() }, { expires: new Date(+instant - 1000).toUTCString() }];
  for (const headers of cases) {
    const f = mockProvider({ headers: { fleet: headers } });
    assert.equal((await f.collector.collect(connection())).status, "stale_data");
  }
});
test("offline, left corporation and docking are accurately represented without pretending to have timed attendance", async () => {
  const offline = await mockProvider({ bodies: { online: { online: false } } }).collector.collect(connection());
  assert.equal(offline.status, "offline"); assert.equal(offline.valid, false);
  const departed = await mockProvider({ bodies: { affiliation: [{ character_id: 20010, corporation_id: 2002 }] } }).collector.collect(connection());
  assert.equal(departed.status, "left_corporation"); assert.equal(departed.valid, false);
  const docked = await mockProvider({ bodies: { location: { solar_system_id: 30000142, station_id: 60003760 } } }).collector.collect(connection());
  assert.equal(docked.docked, true); assert.equal(docked.valid, true);
});
test("401/403 demand authorization, missing fleet and rate/network errors do not become attendance", async () => {
  for (const [status, expected] of [[401, "authorization_required"], [403, "authorization_required"], [404, "not_in_fleet"], [420, "rate_limited"], [429, "rate_limited"], [500, "unavailable"]] as const) {
    const result = await mockProvider({ statuses: { fleet: status } }).collector.collect(connection());
    assert.equal(result.status, expected); assert.equal(result.valid, false); assert.equal(result.evidenceAt, null);
  }
  const collector = createDutyPapCollector({ fetchImpl: async () => { throw new Error("secret upstream body test-token"); }, now: () => instant });
  const result = await collector.collect(connection());
  assert.equal(result.status, "unavailable"); assert.equal(JSON.stringify(result).includes("test-token"), false);
});
test("malformed/incomplete/oversized data fails as unavailable, not a made-up zero or valid state", async () => {
  for (const bodies of [{ ship: {} }, { location: { solar_system_id: 30000142, structure_id: "bad" } }, { online: { online: "true" } }, { affiliation: [{ character_id: 999, corporation_id: 1001 }] }, { fleet: { fleet_id: -1 } }]) assert.equal((await mockProvider({ bodies }).collector.collect(connection())).status, "unavailable");
  const invalid = mockProvider({ response: () => new Response("<html>failure</html>", { headers: { date: instant.toUTCString() } }) });
  assert.equal((await invalid.collector.collect(connection())).status, "unavailable");
  const oversized = mockProvider({ response: () => new Response(" ".repeat(65_537), { headers: { date: instant.toUTCString() } }) });
  assert.equal((await oversized.collector.collect(connection())).status, "unavailable");
});
test("refresh only updates its separate connection credentials, does not publish refresh failure text", async () => {
  let refreshed = 0;
  const mock = mockProvider(), collector = createDutyPapCollector({ now: () => instant, fetchImpl: async (url, init) => {
    assert.equal(new Headers(init?.headers).get("authorization") ?? "Bearer refreshed-access", "Bearer refreshed-access");
    return new Response(JSON.stringify(String(url).endsWith("/affiliation") ? [{ character_id: 20010, corporation_id: 1001 }] : String(url).endsWith("/fleet") ? { fleet_id: 123 } : String(url).endsWith("/online") ? { online: true } : String(url).endsWith("/location") ? { solar_system_id: 30000142 } : { ship_type_id: 587 }), { headers: { date: instant.toUTCString() } });
  }, refreshTokens: async () => { refreshed++; return { accessToken: "refreshed-access", refreshToken: "refreshed-refresh", expiresIn: 3600 }; } });
  const result = await collector.collect(connection({ tokenExpiry: new Date(+instant + 1000) }));
  assert.equal(refreshed, 1); assert.equal(result.valid, true); assert.equal(result.tokenUpdate!.accessToken, "refreshed-access");
  const bad = createDutyPapCollector({ now: () => instant, fetchImpl: async () => { throw new Error("must not fetch"); }, refreshTokens: async () => { throw new EveTokenRefreshError(true); } });
  assert.equal((await bad.collect(connection({ tokenExpiry: instant }))).status, "authorization_required");
  assert.equal(mock.calls.length, 0);
});
test("caller cancellation stops collection and cannot yield an eligible observation", async () => {
  const controller = new AbortController();
  const collector = createDutyPapCollector({ now: () => instant, fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => { if (init?.signal?.aborted) reject(new Error("aborted")); else init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) });
  const pending = collector.collect(connection(), { signal: controller.signal }); controller.abort();
  const result = await pending; assert.equal(result.status, "unavailable"); assert.equal(result.valid, false);
});
test("429 or low shared ESI error budget pauses subsequent collection without fan-out", async () => {
  let calls = 0, now = new Date(instant);
  const collector = createDutyPapCollector({ now: () => now, fetchImpl: async () => { calls++; return new Response("{}", { status: 429, headers: { date: now.toUTCString(), "retry-after": "120" } }); } });
  assert.equal((await collector.collect(connection())).status, "rate_limited");
  const count = calls; assert.equal((await collector.collect(connection())).status, "rate_limited"); assert.equal(calls, count);
  now = new Date(+now + 121_000); await collector.collect(connection()); assert.equal(calls > count, true);
});
test("public affiliation client cache expires from origin evidence, never renews old cache lifetime", async () => {
  let now = new Date(instant), affiliationCalls = 0;
  const collector = createDutyPapCollector({ now: () => now, fetchImpl: async (url) => {
    const key = String(url).split("/").at(-1)!;
    const bodies: Record<string, unknown> = { fleet: { fleet_id: 123 }, online: { online: true }, location: { solar_system_id: 30000142 }, ship: { ship_type_id: 587 }, affiliation: [{ character_id: 20010, corporation_id: 1001 }] };
    if (key === "affiliation") affiliationCalls++;
    return new Response(JSON.stringify(bodies[key]), { headers: { date: now.toUTCString(), ...(key === "affiliation" ? { age: "3500", "cache-control": "max-age=3600" } : {}) } });
  } });
  assert.equal((await collector.collect(connection())).valid, true); assert.equal(affiliationCalls, 1);
  now = new Date(+now + 60_000); assert.equal((await collector.collect(connection())).valid, true); assert.equal(affiliationCalls, 1);
  now = new Date(+now + 41_000); assert.equal((await collector.collect(connection())).valid, true); assert.equal(affiliationCalls, 2);
});
test("HTTP-date Retry-After and long seconds prevent premature requests, low error budget also pauses", async () => {
  const cases: Record<string, string>[] = [{ "retry-after": new Date(+instant + 3_600_000).toUTCString() }, { "retry-after": "3600" }, { "x-esi-error-limit-remain": "5", "x-esi-error-limit-reset": "3600" }];
  for (const headers of cases) {
    let now = new Date(instant), calls = 0;
    const collector = createDutyPapCollector({ now: () => now, fetchImpl: async () => { calls++; return new Response("{}", { status: "x-esi-error-limit-remain" in headers ? 200 : 429, headers: { date: now.toUTCString(), ...headers } }); } });
    await collector.collect(connection()); const count = calls;
    now = new Date(+now + 1_000_000); assert.equal((await collector.collect(connection())).status, "rate_limited"); assert.equal(calls, count);
  }
});
