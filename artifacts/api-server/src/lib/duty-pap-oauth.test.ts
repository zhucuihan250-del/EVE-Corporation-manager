import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Request, Response } from "express";
import { createDutyPapOAuthHandlers, createDutyPapOAuthProvider, type DutyPapOAuthTarget } from "./duty-pap-oauth";
import { DUTY_PAP_SCOPES, DutyPapError } from "./duty-pap-rules";
import { getAuthorizationUrl, getLinkAltAuthorizationUrl } from "./eve-sso";

const STAMP = Date.parse("2026-10-04T10:00:00Z");
const CALLBACK = "https://test.example/api/auth/eve/callback";
const rejectCode = (code: string) => (error: unknown) => error instanceof DutyPapError && error.code === code;
function jwt(overrides: Record<string, unknown> = {}) {
  const claims = { sub: "CHARACTER:EVE:101", azp: "test-client-id", exp: Math.floor(STAMP / 1000) + 1200, scp: [...DUTY_PAP_SCOPES], ...overrides };
  return `${Buffer.from('{"alg":"RS256"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-signature`;
}
function providerFixture(options: { claims?: Record<string, unknown>; verifiedId?: number; affiliation?: unknown; responseOverride?: (url: string) => globalThis.Response | undefined } = {}) {
  const calls: { url: string; method: string; body: string; headers: Headers }[] = [];
  const token = jwt(options.claims);
  const request = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = String(input); calls.push({ url, method: init?.method ?? "GET", body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
    const override = options.responseOverride?.(url); if (override) return override;
    const payload = url.endsWith("/v2/oauth/token") ? { access_token: token, refresh_token: "dedicated-refresh-fixture", expires_in: 1200 }
      : url.endsWith("/oauth/verify") ? { CharacterID: options.verifiedId ?? 101, CharacterName: "非敏感测试角色" }
        : options.affiliation ?? [{ character_id: 101, corporation_id: 1001 }];
    return globalThis.Response.json(payload);
  }) as typeof fetch;
  const provider = createDutyPapOAuthProvider({ request, now: () => STAMP, getConfig: () => ({ clientId: "test-client-id", clientSecret: "fixture-client-secret" }) });
  return { provider, calls, token };
}

test("dedicated duty consent requests exactly four read-only scopes without broadening legacy login or alt consent", () => {
  const f = providerFixture(), url = new URL(f.provider.authorizationUrl(CALLBACK, "test-state"));
  assert.equal(url.origin + url.pathname, "https://login.eveonline.com/v2/oauth/authorize");
  assert.equal(url.searchParams.get("redirect_uri"), CALLBACK); assert.equal(url.searchParams.get("state"), "test-state");
  assert.deepEqual(url.searchParams.get("scope")!.split(" "), ["publicData", ...DUTY_PAP_SCOPES]);
  assert.ok(url.searchParams.get("scope")!.split(" ").every(scope => !scope.includes("write")));
  const previous = process.env.EVE_CLIENT_ID; process.env.EVE_CLIENT_ID = "test-client-id";
  try {
    assert.deepEqual(new URL(getAuthorizationUrl(CALLBACK, "test-state")).searchParams.get("scope")!.split(" "),
      ["publicData", "esi-skills.read_skills.v1", "esi-fleets.read_fleet.v1", "esi-fleets.write_fleet.v1"]);
    assert.deepEqual(new URL(getLinkAltAuthorizationUrl(CALLBACK, "test-state")).searchParams.get("scope")!.split(" "), ["publicData", "esi-skills.read_skills.v1"]);
  } finally { if (previous === undefined) delete process.env.EVE_CLIENT_ID; else process.env.EVE_CLIENT_ID = previous; }
});

test("dedicated provider exchanges, officially verifies, binds scopes/client/character then reads only that character affiliation", async () => {
  const f = providerFixture(), verified = await f.provider.exchangeAndVerify("fixture-code", CALLBACK);
  assert.equal(verified.eveCharacterId, 101); assert.equal(verified.corporationId, 1001); assert.deepEqual(verified.scopes, [...DUTY_PAP_SCOPES]);
  assert.equal(verified.accessToken, f.token); assert.equal(verified.refreshToken, "dedicated-refresh-fixture");
  assert.equal(verified.tokenExpiry.getTime(), STAMP + 1_200_000);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].method, "POST"); assert.equal(new URLSearchParams(f.calls[0].body).get("redirect_uri"), CALLBACK);
  assert.equal(new URLSearchParams(f.calls[0].body).get("code"), "fixture-code");
  assert.equal(f.calls[1].headers.get("authorization"), `Bearer ${f.token}`);
  assert.equal(f.calls[2].body, "[101]"); assert.equal(f.calls[2].headers.get("authorization"), null);
  assert.ok(f.calls.every(call => !call.url.includes("fleet/") && !call.url.includes("members")));
});

test("missing scope, expired claims, client mismatch and verified-character mismatch fail before affiliation lookup", async () => {
  for (const options of [
    { claims: { scp: DUTY_PAP_SCOPES.slice(0, 3) } }, { claims: { exp: STAMP / 1000 } },
    { claims: { azp: "other-client" } }, { claims: { sub: "CHARACTER:EVE:999" } }, { verifiedId: 999 },
    { claims: { scp: "esi-fleets.read_fleet.v1" } },
  ]) {
    const f = providerFixture(options);
    await assert.rejects(f.provider.exchangeAndVerify("fixture-code", CALLBACK), rejectCode("DUTY_PAP_AUTH_SCOPE_REQUIRED"));
    assert.equal(f.calls.length, 2);
  }
});

test("invalid SSO/upstream responses are bounded and expose only fixed safe errors", async () => {
  const secret = "DO_NOT_EXPOSE_FIXTURE_SECRET";
  for (const response of [new globalThis.Response(secret, { status: 401 }), new globalThis.Response(`<html>${secret}</html>`),
    new globalThis.Response(`{"access_token":"${secret}${"x".repeat(66000)}"}`), globalThis.Response.json({ access_token: secret, refresh_token: secret, expires_in: -1 })]) {
    const f = providerFixture({ responseOverride: url => url.endsWith("/v2/oauth/token") ? response : undefined });
    await assert.rejects(f.provider.exchangeAndVerify(secret, CALLBACK), error => {
      assert.ok(error instanceof DutyPapError); assert.equal(error.code, "DUTY_PAP_AUTH_UNAVAILABLE"); assert.doesNotMatch(String(error), new RegExp(secret)); return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const unavailable = createDutyPapOAuthProvider({ getConfig: () => ({}) });
  assert.throws(() => unavailable.authorizationUrl(CALLBACK, secret), rejectCode("DUTY_PAP_AUTH_UNAVAILABLE"));
  await assert.rejects(unavailable.exchangeAndVerify(secret, CALLBACK), rejectCode("DUTY_PAP_AUTH_UNAVAILABLE"));
  for (const affiliation of [[], [{ character_id: 999, corporation_id: 1001 }], [{ character_id: 101, corporation_id: "1001" }], { character_id: 101, corporation_id: 1001 }]) {
    const f = providerFixture({ affiliation }); await assert.rejects(f.provider.exchangeAndVerify("fixture-code", CALLBACK), rejectCode("DUTY_PAP_AUTH_UNAVAILABLE"));
  }
});

type AuthorizeInput = Parameters<Parameters<typeof createDutyPapOAuthHandlers>[0]["service"]["authorizeConnection"]>[1];
async function handlerFixture() {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE characters(id integer PRIMARY KEY,user_id integer,eve_character_id integer NOT NULL,eve_character_name text NOT NULL,corporation_id integer,corporation_name text,access_token text,refresh_token text,token_expiry timestamptz,is_main boolean NOT NULL,deleted_at timestamptz,retained_until timestamptz,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
    INSERT INTO characters VALUES(11,1,101,'本人角色',1001,'本军团','original-skills-token','original-skills-refresh',now(),true,NULL,NULL,now(),now()),
      (12,1,102,'已删除角色',1001,'本军团','old-token','old-refresh',now(),false,now(),now(),now(),now()),
      (13,2,103,'他人角色',1001,'本军团','other-token','other-refresh',now(),true,NULL,NULL,now(),now()),
      (31,1,131,'外军团小号',2002,'外军团','foreign-token','foreign-refresh',now(),false,NULL,NULL,now(),now());
    CREATE TABLE duty_pap_connections(id integer PRIMARY KEY,corporation_id integer NOT NULL,user_id integer NOT NULL,version integer NOT NULL);
    INSERT INTO duty_pap_connections VALUES(1,1001,1,7);`);
  const tenant = { user: { id: 1, eveCharacterName: "测试账号" }, corporation: { id: 1001, papEnabled: true, fleetEnabled: true }, membership: { role: "member" } } as unknown as NonNullable<Request["tenant"]>;
  const authorizations: AuthorizeInput[] = [], exchanges: string[] = [];
  let returnedTenant: NonNullable<Request["tenant"]> | null = tenant;
  let verifiedId = 101, verifiedCorp = 1001, versionFailure = false;
  const provider = { authorizationUrl: (url: string, state: string) => `https://login.eveonline.com/v2/oauth/authorize?${new URLSearchParams({ redirect_uri: url, state })}`, exchangeAndVerify: async (code: string) => {
    exchanges.push(code); return { eveCharacterId: verifiedId, corporationId: verifiedCorp, scopes: [...DUTY_PAP_SCOPES], accessToken: "dedicated-access", refreshToken: "dedicated-refresh", tokenExpiry: new Date(STAMP + 1_200_000) };
  } };
  const service = { authorizeConnection: async (_actor: unknown, input: AuthorizeInput) => {
    if (versionFailure) throw new DutyPapError(409, "DUTY_PAP_VERSION_CONFLICT", "值守授权状态已变化，请重新开始授权。");
    authorizations.push(input); return { connection: null };
  } } as unknown as Parameters<typeof createDutyPapOAuthHandlers>[0]["service"];
  const handlers = createDutyPapOAuthHandlers({ database: drizzle(pg) as unknown as Parameters<typeof createDutyPapOAuthHandlers>[0]["database"], service, provider, getTenant: async () => returnedTenant, now: () => STAMP });
  function request(query: Record<string, unknown> = { characterId: "11" }) {
    const session = { userId: 1, linkingUserId: 2, economyLinkCorporationId: 1001, rosterLinkCorporationId: 1001, structuresLinkCorporationId: 1001, save: (callback?: (error?: Error) => void) => callback?.() };
    return { query, tenant, session, protocol: "http", get: (header: string) => ({ "x-forwarded-host": "test.example, ignored.example", "x-forwarded-proto": "https, http", host: "internal.example" } as Record<string, string>)[header] } as unknown as Request;
  }
  function response() {
    let status = 200, body: unknown, location: string | undefined;
    const res = { status(code: number) { status = code; return res; }, json(value: unknown) { body = value; return res; }, redirect(value: string) { status = 302; location = value; return res; } } as unknown as Response;
    return { res, result: () => ({ status, body, location }) };
  }
  const target: DutyPapOAuthTarget = { corporationId: 1001, userId: 1, characterId: 11, issuedAt: STAMP, connectionVersion: 7 };
  return { pg, tenant, handlers, request, response, target, authorizations, exchanges, close: () => pg.close(),
    setTenant: (value: NonNullable<Request["tenant"]> | null) => { returnedTenant = value; }, setVerified: (id: number, corp: number) => { verifiedId = id; verifiedCorp = corp; }, conflict: () => { versionFailure = true; } };
}

test("start binds the selected own character, account, corporation and connection version to a saved session", async () => {
  const f = await handlerFixture();
  try {
    const before = (await f.pg.query("SELECT access_token,refresh_token FROM characters WHERE id=11")).rows;
    const req = f.request(), res = f.response(); await f.handlers.start(req, res.res);
    assert.equal(res.result().status, 302); assert.equal(new URL(res.result().location!).searchParams.get("redirect_uri"), CALLBACK);
    assert.equal(req.session.eveOauthFlow, "duty"); assert.ok(req.session.eveOauthState!.length >= 32);
    assert.deepEqual(req.session.dutyPapAuthorization, f.target);
    for (const key of ["linkingUserId", "economyLinkCorporationId", "rosterLinkCorporationId", "structuresLinkCorporationId"] as const) assert.equal(req.session[key], undefined);
    assert.equal(f.authorizations.length, 0); assert.equal(f.exchanges.length, 0);
    assert.deepEqual((await f.pg.query("SELECT access_token,refresh_token FROM characters WHERE id=11")).rows, before);
  } finally { await f.close(); }
});

test("start rejects malformed ids, someone else's role, deleted role and external-corporation alt before exchange", async () => {
  const f = await handlerFixture();
  try {
    for (const id of ["11x", "11.0", "0", "-1", " 11", ["11"], undefined, "99999999999"]) {
      const req = f.request({ characterId: id }), res = f.response(); await f.handlers.start(req, res.res); assert.equal(res.result().status, 400); assert.equal(req.session.eveOauthFlow, undefined);
    }
    for (const id of ["12", "13", "31", "999"]) {
      const req = f.request({ characterId: id }), res = f.response(); await f.handlers.start(req, res.res); assert.equal(res.result().status, 404); assert.equal(req.session.eveOauthFlow, undefined);
    }
    const req = f.request(), res = f.response(); req.tenant = undefined; await f.handlers.start(req, res.res); assert.equal(res.result().status, 401);
    assert.equal(f.exchanges.length, 0); assert.equal(f.authorizations.length, 0);
  } finally { await f.close(); }
});

test("complete preserves expected connection version and delegates only the verified selected character's separate credentials", async () => {
  const f = await handlerFixture();
  try {
    await f.handlers.complete(f.request(), f.target, "fixture-code", CALLBACK);
    assert.equal(f.authorizations.length, 1); assert.equal(f.authorizations[0].expectedVersion, 7); assert.equal(f.authorizations[0].characterId, 11);
    assert.equal(f.authorizations[0].accessToken, "dedicated-access"); assert.deepEqual(f.authorizations[0].scopes, [...DUTY_PAP_SCOPES]);
    assert.deepEqual((await f.pg.query("SELECT access_token,refresh_token FROM characters WHERE id=11")).rows, [{ access_token: "original-skills-token", refresh_token: "original-skills-refresh" }]);
    f.conflict(); await assert.rejects(f.handlers.complete(f.request(), f.target, "second-code", CALLBACK), rejectCode("DUTY_PAP_VERSION_CONFLICT"));
    assert.equal(f.authorizations.length, 1);
  } finally { await f.close(); }
});

test("complete rechecks account, tenant, TTL, modules and selected-role ownership before exchange", async () => {
  const f = await handlerFixture();
  try {
    for (const target of [undefined, { ...f.target, userId: 2 }, { ...f.target, issuedAt: STAMP - 900001 }, { ...f.target, issuedAt: STAMP + 1 }, { ...f.target, issuedAt: NaN }]) {
      await assert.rejects(f.handlers.complete(f.request(), target, "fixture-code", CALLBACK), rejectCode("DUTY_PAP_AUTH_EXPIRED"));
    }
    for (const target of [{ ...f.target, corporationId: 2002 }, { ...f.target, characterId: 12 }, { ...f.target, characterId: 13 }, { ...f.target, characterId: 31 }]) {
      await assert.rejects(f.handlers.complete(f.request(), target, "fixture-code", CALLBACK), rejectCode(target.corporationId === 2002 ? "DUTY_PAP_AUTH_FORBIDDEN" : "DUTY_PAP_CHARACTER_NOT_FOUND"));
    }
    f.setTenant(null); await assert.rejects(f.handlers.complete(f.request(), f.target, "fixture-code", CALLBACK), rejectCode("DUTY_PAP_AUTH_FORBIDDEN"));
    for (const disabled of ["papEnabled", "fleetEnabled"]) {
      f.setTenant({ ...f.tenant, corporation: { ...f.tenant.corporation, [disabled]: false } });
      await assert.rejects(f.handlers.complete(f.request(), f.target, "fixture-code", CALLBACK), rejectCode("DUTY_PAP_AUTH_FORBIDDEN"));
    }
    assert.equal(f.exchanges.length, 0); assert.equal(f.authorizations.length, 0);
  } finally { await f.close(); }
});

test("complete refuses wrong EVE character, departed member and roles unlinked during consent", async () => {
  const f = await handlerFixture();
  try {
    f.setVerified(999, 1001); await assert.rejects(f.handlers.complete(f.request(), f.target, "fixture-code", CALLBACK), rejectCode("DUTY_PAP_AUTH_CHARACTER_MISMATCH"));
    f.setVerified(101, 2002); await assert.rejects(f.handlers.complete(f.request(), f.target, "fixture-code", CALLBACK), rejectCode("DUTY_PAP_AUTH_CHARACTER_MISMATCH"));
    f.setVerified(101, 1001); await f.pg.exec("UPDATE characters SET user_id=NULL,deleted_at=now() WHERE id=11");
    await assert.rejects(f.handlers.complete(f.request(), f.target, "fixture-code", CALLBACK), rejectCode("DUTY_PAP_CHARACTER_NOT_FOUND"));
    assert.equal(f.exchanges.length, 2); assert.equal(f.authorizations.length, 0);
  } finally { await f.close(); }
});
