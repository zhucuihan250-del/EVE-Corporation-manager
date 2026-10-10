import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import express, { type Request, type Response, type NextFunction } from "express";
import { type Server } from "node:http";
import { pg } from "./single-corporation-test-db";
import { getSiteCorporation, ensureCharacterCorporationReference } from "./single-corporation";
import { ensureCorporation, ensureCorporationMembership, getTenantContext } from "./tenant";
import { requireAuth, requireRole, requireRoleOrPermission } from "../middlewares/auth";
import authRouter from "../routes/auth";
import { purgeExpiredDeletedCharacters } from "./character-retention";
import { settleDueActivityMonths } from "./activity-monthly-settlement";
import { editablePapCurrenciesMigration } from "../../../../lib/db/src/migrations/0030-editable-pap-currencies";
import { fittingWorkbenchMigration } from "../../../../lib/db/src/migrations/0032-fitting-workbench";
import { automaticDutyPapMigration } from "../../../../lib/db/src/migrations/0033-automatic-duty-pap";
import { memberForumMigration } from "../../../../lib/db/src/migrations/0034-member-forum";
import { DUTY_PAP_SCOPES } from "./duty-pap-rules";

// Bundle this test with @workspace/db aliased to single-corporation-test-db.ts.
// It exercises the real middleware and OAuth routes against in-memory Postgres.
// All EVE HTTP requests are fixtures; any unexpected remote request fails.
const realFetch = globalThis.fetch;
const originalEnvironment = { ...process.env };
let server: Server;
let origin = "";
let currentSession: Record<string, unknown>;
let destroyed = false;
let lastOAuthError: unknown;
let ssoCharacter = { characterId: 101, characterName: "Member", corporationId: 1001 };
let dutyTokenFixture = false;
let affiliationUnavailable = false;

function session(values: Record<string, unknown> = {}) {
  return {
    userId: 1, corporationId: 1001, eveCharacterId: 101,
    save: (callback?: (error?: Error) => void) => callback?.(),
    destroy: (callback?: () => void) => { destroyed = true; callback?.(); },
    ...values,
  };
}

function request(values: Record<string, unknown> = {}) {
  return { session: session(values) } as unknown as Request;
}

async function runGuard(guard: (req: Request, res: Response, next: NextFunction) => unknown, req: Request) {
  let status = 200;
  let passed = false;
  let failure: unknown;
  const response = {
    status(code: number) { status = code; return this; },
    json() { return this; },
  } as unknown as Response;
  await guard(req, response, (error?: unknown) => { if (error) failure = error; else passed = true; });
  if (failure) throw failure;
  return { status, passed };
}

before(async () => {
  process.env.EVE_CLIENT_ID = "test-client";
  process.env.EVE_CLIENT_SECRET = "test-secret-not-real";
  process.env.NODE_ENV = "production";
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (origin && url.startsWith(`${origin}/`)) return realFetch(input, init);
    if (url === "https://login.eveonline.com/v2/oauth/token") {
      const claims = Buffer.from(JSON.stringify({ sub: `CHARACTER:EVE:${ssoCharacter.characterId}`, scp: DUTY_PAP_SCOPES, azp: "test-client", exp: Math.floor(Date.now() / 1000) + 1200 })).toString("base64url");
      return Response.json({ access_token: dutyTokenFixture ? `fixture.${claims}.fixture` : "fixture-access", refresh_token: "fixture-refresh", expires_in: 1200 });
    }
    if (url === "https://login.eveonline.com/oauth/verify") {
      return Response.json({ CharacterID: ssoCharacter.characterId, CharacterName: ssoCharacter.characterName });
    }
    if (url === "https://esi.evetech.net/latest/characters/affiliation/?datasource=tranquility") {
      if (affiliationUnavailable) return Response.json({ error: "Fixture outage" }, { status: 503 });
      return Response.json([{ character_id: ssoCharacter.characterId, corporation_id: ssoCharacter.corporationId }]);
    }
    if (url === "https://esi.evetech.net/characters/affiliation") {
      assert.equal(init?.method, "POST");
      assert.deepEqual(JSON.parse(String(init?.body)), [ssoCharacter.characterId]);
      return Response.json([{ character_id: ssoCharacter.characterId, corporation_id: ssoCharacter.corporationId }]);
    }
    if (/^https:\/\/esi\.evetech\.net\/latest\/corporations\/\d+\//.test(url)) {
      return Response.json({ name: ssoCharacter.corporationId === 1001 ? "Home" : "External" });
    }
    if (/^https:\/\/esi\.evetech\.net\/latest\/characters\/\d+\/corporationhistory\//.test(url)) {
      return Response.json([{ corporation_id: ssoCharacter.corporationId, start_date: "2026-01-01T00:00:00Z" }]);
    }
    if (/^https:\/\/esi\.evetech\.net\/latest\/characters\/\d+\/\?/.test(url)) {
      return Response.json({ corporation_id: ssoCharacter.corporationId });
    }
    throw new Error(`Unexpected request in isolated OAuth test: ${url}`);
  }) as typeof fetch;

  await pg.exec(`
    CREATE TABLE corporations (
      id integer PRIMARY KEY, name text NOT NULL, is_primary boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, pap_enabled boolean NOT NULL DEFAULT false,
      identity_enabled boolean NOT NULL DEFAULT false, economy_enabled boolean NOT NULL DEFAULT false,
      fleet_enabled boolean NOT NULL DEFAULT false, reimbursement_enabled boolean NOT NULL DEFAULT true,
      reimbursement_open boolean NOT NULL DEFAULT true, diplomacy_enabled boolean NOT NULL DEFAULT true,
      courier_enabled boolean NOT NULL DEFAULT false, structures_enabled boolean NOT NULL DEFAULT false,
      activity_minimum_pap double precision NOT NULL DEFAULT 2,
      activity_deduction_started_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users (
      id serial PRIMARY KEY, eve_character_id integer, eve_character_name text,
      corporation_id integer, corporation_name text, corporation_joined_at timestamptz,
      access_token text, refresh_token text, token_expiry timestamptz, role text NOT NULL DEFAULT 'member',
      total_pap double precision NOT NULL DEFAULT 0, redeemable_pap double precision NOT NULL DEFAULT 0,
      locked_pap double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE corporation_memberships (
      id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id),
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, role text NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (corporation_id, user_id));
    CREATE TABLE characters (
      id serial PRIMARY KEY, user_id integer REFERENCES users(id), eve_character_id integer NOT NULL,
      eve_character_name text NOT NULL, corporation_id integer REFERENCES corporations(id), corporation_name text,
      access_token text, refresh_token text, token_expiry timestamptz,
      is_main boolean NOT NULL DEFAULT false, deleted_at timestamptz, retained_until timestamptz,
      membership_status text NOT NULL DEFAULT 'unknown', actual_corporation_id integer,
      membership_checked_at timestamptz, corporation_left_at timestamptz, membership_retained_until timestamptz, retention_corporation_id integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE identity_groups (id integer PRIMARY KEY, corporation_id integer NOT NULL,
      permissions jsonb NOT NULL DEFAULT '[]', is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE identity_group_memberships (id serial PRIMARY KEY, corporation_id integer NOT NULL,
      group_id integer NOT NULL, user_id integer NOT NULL);
    CREATE TABLE activity_monthly_settlements (id serial PRIMARY KEY, corporation_id integer NOT NULL, month text NOT NULL);
    CREATE TABLE pap_records (id serial PRIMARY KEY, user_id integer);
    CREATE TABLE pap_market_orders (owner_id integer, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE pap_market_transactions (buyer_id integer, seller_id integer, reviewed_by integer, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE pap_ledger (user_id integer, admin_id integer, type text);
    CREATE TABLE pap_market_admin_logs (admin_id integer);
  `);
  const migrationClient = { query: (statement: string) => pg.exec(statement) } as unknown as Parameters<typeof fittingWorkbenchMigration.up>[0];
  await editablePapCurrenciesMigration.up(migrationClient);
  await fittingWorkbenchMigration.up(migrationClient);
  await automaticDutyPapMigration.up(migrationClient);
  await memberForumMigration.up(migrationClient);
  const app = express();
  app.use((req, _res, next) => {
    req.session = currentSession as unknown as Request["session"];
    req.log = { info() {}, error(value: unknown) { lastOAuthError = value; }, warn() {} } as unknown as Request["log"];
    next();
  });
  app.use(authRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  delete process.env.PRIMARY_CORPORATION_ID;
  destroyed = false;
  lastOAuthError = undefined;
  currentSession = session();
  ssoCharacter = { characterId: 101, characterName: "Member", corporationId: 1001 };
  dutyTokenFixture = false;
  affiliationUnavailable = false;
  await pg.exec(`
    TRUNCATE duty_pap_awards, duty_pap_progress, duty_pap_connections, duty_pap_rules,
      forum_attachments, forum_replies, forum_posts,
      fittings, pap_currency_ledger, pap_currency_wallets, pap_currencies,
      pap_records, pap_market_orders, pap_market_transactions, pap_ledger, pap_market_admin_logs,
      activity_monthly_settlements, identity_group_memberships, identity_groups, characters, corporation_memberships,
      users, corporations RESTART IDENTITY;
    INSERT INTO corporations (id, name, is_primary, pap_enabled, fleet_enabled, identity_enabled)
      VALUES (1001, 'Home', true, true, true, true), (2002, 'Historical foreign site', false, true, true, true);
    INSERT INTO users (eve_character_id, eve_character_name, corporation_id, role, access_token) VALUES
      (101, 'Member', 1001, 'controller', 'fixture-existing'),
      (201, 'External', 2002, 'controller', 'fixture-existing'),
      (301, 'FC', 1001, 'member', 'fixture-existing'),
      (401, 'Admin', 1001, 'member', 'fixture-existing'),
      (501, 'Controller', 1001, 'member', 'fixture-existing');
    INSERT INTO corporation_memberships (corporation_id, user_id, role) VALUES
      (1001, 1, 'member'), (2002, 2, 'controller'), (1001, 3, 'fc'),
      (1001, 4, 'admin'), (1001, 5, 'controller');
    INSERT INTO characters (user_id, eve_character_id, eve_character_name, corporation_id, is_main) VALUES
      (1, 101, 'Member', 1001, true), (2, 201, 'External', 2002, true),
      (3, 301, 'FC', 1001, true), (4, 401, 'Admin', 1001, true), (5, 501, 'Controller', 1001, true),
      (1, 102, 'Home alt', 1001, false), (1, 202, 'External alt', 2002, false);
  `);
});

after(async () => {
  globalThis.fetch = realFetch;
  for (const key of ["PRIMARY_CORPORATION_ID", "EVE_CLIENT_ID", "EVE_CLIENT_SECRET", "NODE_ENV"]) {
    if (originalEnvironment[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnvironment[key];
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await pg.close();
});

test("database home selection falls back to one primary and rejects ambiguity or explicit bad config", async () => {
  assert.equal((await getSiteCorporation())?.id, 1001);
  await pg.exec("UPDATE corporations SET is_primary=true WHERE id=2002");
  assert.equal(await getSiteCorporation(), null);
  process.env.PRIMARY_CORPORATION_ID = "1001";
  assert.equal((await getSiteCorporation())?.id, 1001);
  process.env.PRIMARY_CORPORATION_ID = "invalid";
  assert.equal(await getSiteCorporation(), null);
});

test("foreign corporation cannot be opened or receive automatic membership", async () => {
  await assert.rejects(ensureCorporation(3003, "New external"));
  await assert.rejects(ensureCorporationMembership(1, 2002, "admin"));
  assert.equal((await pg.query("SELECT id FROM corporations WHERE id=3003")).rows.length, 0);
  assert.equal((await pg.query("SELECT id FROM corporation_memberships WHERE user_id=1 AND corporation_id=2002")).rows.length, 0);
});

test("existing site roles survive while newly provisioned roles never import global privileges", async () => {
  for (const [userId, role] of [[1, "member"], [3, "fc"], [4, "admin"], [5, "controller"]] as const) {
    assert.equal((await ensureCorporationMembership(userId, 1001, "controller")).role, role);
  }
  assert.equal((await ensureCorporationMembership(2, 1001, "controller")).role, "member");
  assert.equal((await pg.query<{ role: string }>("SELECT role FROM corporation_memberships WHERE corporation_id=2002 AND user_id=2")).rows[0].role, "controller");
});

test("home members and legacy home sessions remain eligible; foreign or deleted actors do not", async () => {
  assert.equal((await getTenantContext(request()))?.user.id, 1);
  assert.equal((await getTenantContext(request({ corporationId: undefined, eveCharacterId: undefined })))?.user.id, 1);
  assert.equal((await getTenantContext(request({ eveCharacterId: 102 })))?.actorCharacter?.eveCharacterId, 102);
  assert.equal(await getTenantContext(request({ eveCharacterId: 202 })), null);
  assert.equal(await getTenantContext(request({ eveCharacterId: 201 })), null);
  await pg.exec("UPDATE characters SET deleted_at=now() WHERE eve_character_id=101");
  assert.equal(await getTenantContext(request()), null);
});

test("requireAuth rejects old foreign sessions even with legacy global/controller or home membership", async () => {
  await ensureCorporationMembership(2, 1001);
  for (const values of [
    { userId: 2, corporationId: 2002, eveCharacterId: 201 },
    { userId: 2, corporationId: 1001, eveCharacterId: 201 },
    { userId: 2, corporationId: undefined, eveCharacterId: undefined },
  ]) assert.deepEqual(await runGuard(requireAuth, request(values)), { status: 403, passed: false });
  assert.deepEqual(await runGuard(requireAuth, request({ userId: undefined })), { status: 401, passed: false });
  assert.deepEqual(await runGuard(requireAuth, request()), { status: 200, passed: true });
});

test("cache cannot be prepopulated or reused after session identity changes", async () => {
  const good = request();
  const tenant = await getTenantContext(good);
  const foreign = request({ userId: 2, corporationId: 2002, eveCharacterId: 201 });
  foreign.tenant = tenant!;
  assert.equal(await getTenantContext(foreign), null);
  good.session.corporationId = 2002;
  assert.equal(await getTenantContext(good), null);
  const actorSwitch = request();
  await getTenantContext(actorSwitch);
  actorSwitch.session.eveCharacterId = 202;
  assert.equal(await getTenantContext(actorSwitch), null);
});

test("member/FC/admin/controller gates and scoped identity-group permissions remain independent", async () => {
  assert.deepEqual(await runGuard(requireRole("admin"), request()), { status: 403, passed: false });
  assert.deepEqual(await runGuard(requireRole("fc"), request({ userId: 3, eveCharacterId: 301 })), { status: 200, passed: true });
  assert.deepEqual(await runGuard(requireRole("admin"), request({ userId: 4, eveCharacterId: 401 })), { status: 200, passed: true });
  assert.deepEqual(await runGuard(requireRole("controller"), request({ userId: 5, eveCharacterId: 501 })), { status: 200, passed: true });
  assert.ok((await getTenantContext(request({ userId: 5, eveCharacterId: 501 })))?.permissions.includes("economy.manage"));
  await pg.exec(`
    INSERT INTO identity_groups VALUES (11, 1001, '["fleet.manage"]', true),
      (12, 1001, '["economy.manage"]', false), (21, 2002, '["economy.manage"]', true);
    INSERT INTO identity_group_memberships (corporation_id, group_id, user_id) VALUES
      (1001, 11, 1), (1001, 12, 1), (2002, 21, 1), (1001, 21, 1);
  `);
  assert.deepEqual((await getTenantContext(request()))?.permissions, ["fleet.manage"]);
  assert.deepEqual(await runGuard(requireRoleOrPermission("fc", "fleet.manage"), request()), { status: 200, passed: true });
  assert.deepEqual(await runGuard(requireRoleOrPermission("controller", "economy.manage"), request()), { status: 403, passed: false });
});

test("external-alt foreign-key reference is inactive and never changes an existing site's settings", async () => {
  await ensureCharacterCorporationReference(3003, "External alt corp");
  const row = (await pg.query<Record<string, unknown>>("SELECT * FROM corporations WHERE id=3003")).rows[0];
  for (const key of ["is_primary", "is_active", "pap_enabled", "identity_enabled", "economy_enabled", "fleet_enabled", "reimbursement_enabled", "reimbursement_open", "diplomacy_enabled", "courier_enabled", "structures_enabled"]) {
    assert.equal(row[key], false, key);
  }
  await ensureCharacterCorporationReference(1001, "Should not overwrite");
  assert.equal((await getSiteCorporation())?.name, "Home");
  assert.equal((await getSiteCorporation())?.fleetEnabled, true);
});

async function callback(flow: "login" | "link_alt", values: Record<string, unknown> = {}) {
  currentSession = session({ eveOauthState: "test-state", eveOauthFlow: flow, ...(flow === "link_alt" ? { linkingUserId: 1 } : {}), ...values });
  return fetch(`${origin}/auth/eve/callback?code=fixture-code&state=test-state`, { redirect: "manual" });
}

test("OAuth rejects a new foreign login before creating any corporation, account or membership", async () => {
  ssoCharacter = { characterId: 303, characterName: "Unknown external", corporationId: 3003 };
  const response = await callback("login", { userId: undefined, corporationId: undefined, eveCharacterId: undefined });
  assert.equal(response.headers.get("location"), "/?error=corporation_required");
  assert.equal(destroyed, true);
  assert.equal((await pg.query("SELECT id FROM corporations WHERE id=3003")).rows.length, 0);
  assert.equal((await pg.query("SELECT id FROM users WHERE eve_character_id=303")).rows.length, 0);
});

test("a verified departure invalidates old home sessions without deleting history or roles", async () => {
  ssoCharacter = { characterId: 401, characterName: "Departed admin", corporationId: 3003 };
  const response = await callback("login");
  assert.equal(response.headers.get("location"), "/?error=corporation_required");
  assert.deepEqual(await runGuard(requireAuth, request({ userId: 4, eveCharacterId: 401 })), { status: 403, passed: false });
  assert.equal((await pg.query<{ role: string }>("SELECT role FROM corporation_memberships WHERE user_id=4 AND corporation_id=1001")).rows[0].role, "admin");
  assert.equal((await pg.query("SELECT id FROM characters WHERE eve_character_id=401")).rows.length, 1);
  assert.equal((await pg.query("SELECT id FROM corporations WHERE id=3003")).rows.length, 0);
});

test("unknown affiliation fails closed but does not mistake an ESI outage for a verified departure", async () => {
  ssoCharacter = { characterId: 401, characterName: "Admin", corporationId: 0 };
  assert.equal((await callback("login")).headers.get("location"), "/?error=corporation_required");
  assert.equal((await pg.query<{ corporation_id: number }>("SELECT corporation_id FROM characters WHERE eve_character_id=401")).rows[0].corporation_id, 1001);
});

test("cached profile fallback after an affiliation outage cannot start departure retention", async () => {
  ssoCharacter = { characterId: 401, characterName: "Admin", corporationId: 3003 };
  affiliationUnavailable = true;
  assert.equal((await callback("login")).headers.get("location"), "/?error=corporation_required");
  const row = (await pg.query<{membership_status:string;membership_retained_until:Date|null}>("SELECT membership_status,membership_retained_until FROM characters WHERE eve_character_id=401")).rows[0];
  assert.equal(row.membership_status,"unknown");
  assert.equal(row.membership_retained_until,null);
});

test("verified home login cancels a departed primary character's scheduled deletion", async () => {
  ssoCharacter = { characterId: 401, characterName: "Admin", corporationId: 3003 };
  assert.equal((await callback("login")).headers.get("location"), "/?error=corporation_required");
  ssoCharacter.corporationId = 1001;
  assert.equal((await callback("login")).headers.get("location"), "/");
  const row = (await pg.query<{membership_status:string;membership_retained_until:Date|null}>("SELECT membership_status,membership_retained_until FROM characters WHERE eve_character_id=401")).rows[0];
  assert.equal(row.membership_status,"member"); assert.equal(row.membership_retained_until,null);
  assert.equal((await getTenantContext({session:currentSession} as unknown as Request))?.membership.role,"admin");
});

test("repeated external alt authorizations do not postpone its original retention deadline", async () => {
  ssoCharacter = { characterId: 303, characterName: "External alt", corporationId: 3003 };
  assert.equal((await callback("link_alt")).headers.get("location"),"/characters?linked=true");
  await pg.exec("UPDATE characters SET corporation_left_at='2026-01-01T00:00:00Z',membership_retained_until='2026-04-01T00:00:00Z' WHERE eve_character_id=303");
  assert.equal((await callback("link_alt")).headers.get("location"),"/characters?linked=true");
  const row = (await pg.query<{membership_retained_until:Date}>("SELECT membership_retained_until FROM characters WHERE eve_character_id=303")).rows[0];
  assert.equal(row.membership_retained_until.toISOString(),"2026-04-01T00:00:00.000Z");
});

test("OAuth permits a fresh home member but never automatically makes them administrator", async () => {
  ssoCharacter = { characterId: 601, characterName: "New home member", corporationId: 1001 };
  const response = await callback("login", { userId: undefined, corporationId: undefined, eveCharacterId: undefined });
  assert.equal(response.headers.get("location"), "/");
  assert.equal(currentSession.corporationId, 1001);
  const tenant = await getTenantContext({ session: currentSession } as unknown as Request);
  assert.equal(tenant?.membership.role, "member");
  assert.equal(tenant?.actorCharacter?.eveCharacterId, 601);
});

test("OAuth preserves an existing admin's site role and a home alt's account ownership", async () => {
  ssoCharacter = { characterId: 401, characterName: "Admin", corporationId: 1001 };
  assert.equal((await callback("login")).headers.get("location"), "/");
  assert.equal((await getTenantContext({ session: currentSession } as unknown as Request))?.membership.role, "admin");
  ssoCharacter = { characterId: 102, characterName: "Home alt", corporationId: 1001 };
  assert.equal((await callback("login")).headers.get("location"), "/");
  assert.equal(currentSession.userId, 1);
  assert.equal(currentSession.eveCharacterId, 102);
});

test("a legitimate home member can link an external alt without granting another website or changing main/session", async () => {
  ssoCharacter = { characterId: 303, characterName: "New external alt", corporationId: 3003 };
  const response = await callback("link_alt");
  assert.equal(response.headers.get("location"), "/characters?linked=true");
  const character = (await pg.query<{ user_id: number; is_main: boolean }>("SELECT user_id, is_main FROM characters WHERE eve_character_id=303")).rows[0];
  assert.deepEqual(character, { user_id: 1, is_main: false });
  assert.equal(currentSession.corporationId, 1001);
  assert.equal(currentSession.eveCharacterId, 101);
  assert.equal((await pg.query("SELECT id FROM corporation_memberships WHERE corporation_id=3003")).rows.length, 0);
  assert.equal((await getTenantContext({ session: currentSession } as unknown as Request))?.user.id, 1);
  assert.equal((await callback("login")).headers.get("location"), "/?error=corporation_required");
});

test("old foreign sessions cannot use a previously started link flow to gain access", async () => {
  ssoCharacter = { characterId: 603, characterName: "External alt", corporationId: 3003 };
  const response = await callback("link_alt", { userId: 2, linkingUserId: 2, corporationId: 2002, eveCharacterId: 201 });
  assert.equal(response.headers.get("location"), "/?error=corporation_required");
  assert.equal((await pg.query("SELECT id FROM corporations WHERE id=3003")).rows.length, 0);
  assert.equal((await pg.query("SELECT id FROM characters WHERE eve_character_id=603")).rows.length, 0);
});

test("linking does not merge or delete historical foreign orphan accounts", async () => {
  await pg.exec("UPDATE users SET access_token=NULL, redeemable_pap=42 WHERE id=2");
  ssoCharacter = { characterId: 201, characterName: "Historical external orphan", corporationId: 2002 };
  assert.equal((await callback("link_alt")).headers.get("location"), "/?error=auth");
  assert.equal((await pg.query<{ redeemable_pap: number }>("SELECT redeemable_pap FROM users WHERE id=2")).rows[0].redeemable_pap, 42);
  assert.equal((await pg.query<{ user_id: number }>("SELECT user_id FROM characters WHERE eve_character_id=201")).rows[0].user_id, 2);
});

async function seedOrphanFittingHistory() {
  await pg.exec(`
    UPDATE users SET total_pap=8, redeemable_pap=8 WHERE id=1;
    UPDATE users SET access_token=NULL, total_pap=4, redeemable_pap=4 WHERE id=3;
    INSERT INTO fittings (corporation_id, visibility, owner_user_id, created_by, updated_by, author_name, name, fit, simulation, version) VALUES
      (1001, 'personal', 3, 3, 3, 'FC', 'Orphan personal draft', '{"schemaVersion":2,"shipTypeId":593}', '{"valid":false,"violations":["overfit"]}', 7),
      (1001, 'corporation', NULL, 3, 3, 'FC', 'Corporation doctrine', '{"schemaVersion":2,"shipTypeId":593}', '{"valid":true}', 4),
      (1001, 'personal', 1, 1, 1, 'Member', 'Existing main draft', '{"schemaVersion":2,"shipTypeId":593}', '{"valid":true}', 2),
      (2002, 'personal', 2, 2, 2, 'External', 'Historical foreign draft', '{"schemaVersion":2,"shipTypeId":593}', '{"valid":true}', 3);
    INSERT INTO pap_records (user_id) VALUES(3);
    INSERT INTO pap_market_orders (owner_id) VALUES(3);
    INSERT INTO pap_market_transactions (buyer_id,seller_id,reviewed_by) VALUES(3,3,3);
    INSERT INTO pap_ledger VALUES(3,3,'pap_earned');
    INSERT INTO pap_market_admin_logs VALUES(3);
    INSERT INTO forum_posts (id,corporation_id,author_user_id,author_name,title,body)
      VALUES(1,1001,3,'FC','Forum history','Original post');
    INSERT INTO forum_replies (corporation_id,post_id,author_user_id,author_name,body)
      VALUES(1001,1,3,'FC','Original reply');
    INSERT INTO forum_attachments (id,corporation_id,owner_user_id,post_id,file_name,mime_type,size,data_base64)
      VALUES('00000000-0000-4000-8000-000000000001',1001,3,1,'History.txt','text/plain',1,'YQ==');
  `);
  ssoCharacter = { characterId: 301, characterName: "FC", corporationId: 1001 };
}

test("real OAuth account merge preserves personal drafts, corporation snapshots and roles without duplicating balances", async () => {
  await seedOrphanFittingHistory();
  const before = (await pg.query<Record<string, unknown>>("SELECT * FROM fittings ORDER BY id")).rows;
  assert.equal((await callback("link_alt")).headers.get("location"), "/characters?linked=true", JSON.stringify(lastOAuthError));
  const after = (await pg.query<Record<string, unknown>>("SELECT * FROM fittings ORDER BY id")).rows;
  assert.equal(after.length, 4);
  assert.deepEqual(after[0], { ...before[0], owner_user_id: 1, created_by: null, updated_by: null });
  assert.deepEqual(after[1], { ...before[1], created_by: null, updated_by: null });
  assert.deepEqual(after.slice(2), before.slice(2));
  assert.deepEqual((await pg.query("SELECT author_user_id,author_name,body FROM forum_posts")).rows[0], { author_user_id: 1, author_name: "FC", body: "Original post" });
  assert.deepEqual((await pg.query("SELECT author_user_id,author_name,body FROM forum_replies")).rows[0], { author_user_id: 1, author_name: "FC", body: "Original reply" });
  assert.deepEqual((await pg.query("SELECT owner_user_id,data_base64 FROM forum_attachments")).rows[0], { owner_user_id: 1, data_base64: "YQ==" });
  assert.equal((await pg.query("SELECT id FROM users WHERE id=3")).rows.length, 0);
  assert.deepEqual((await pg.query("SELECT user_id,is_main FROM characters WHERE eve_character_id=301")).rows[0], { user_id: 1, is_main: false });
  assert.equal((await pg.query<{ role: string }>("SELECT role FROM corporation_memberships WHERE user_id=1 AND corporation_id=1001")).rows[0].role, "member");
  assert.deepEqual((await pg.query("SELECT total_pap,redeemable_pap FROM users WHERE id=1")).rows[0], { total_pap: 12, redeemable_pap: 12 });
  assert.equal((await callback("link_alt")).headers.get("location"), "/characters?linked=true");
  assert.deepEqual((await pg.query("SELECT total_pap,redeemable_pap FROM users WHERE id=1")).rows[0], { total_pap: 12, redeemable_pap: 12 });
  assert.deepEqual((await pg.query<Record<string, unknown>>("SELECT * FROM fittings ORDER BY id")).rows, after);
});

test("real OAuth account merge rolls fitting ownership and PAP history back when account deletion fails", async () => {
  await seedOrphanFittingHistory();
  const fittingBefore = (await pg.query("SELECT * FROM fittings ORDER BY id")).rows;
  const usersBefore = (await pg.query("SELECT * FROM users ORDER BY id")).rows;
  const charactersBefore = (await pg.query("SELECT * FROM characters ORDER BY id")).rows;
  await pg.exec(`
    CREATE FUNCTION fail_test_orphan_delete() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF OLD.id=3 THEN RAISE EXCEPTION 'Fixture account-delete failure'; END IF; RETURN OLD; END; $$;
    CREATE TRIGGER fail_test_orphan_delete BEFORE DELETE ON users FOR EACH ROW EXECUTE FUNCTION fail_test_orphan_delete();
  `);
  try {
    assert.equal((await callback("link_alt")).headers.get("location"), "/?error=auth");
    assert.equal((lastOAuthError as { errorCode?: string })?.errorCode, "P0001", "Rollback must be caused by the injected DELETE trigger");
    assert.deepEqual((await pg.query("SELECT * FROM fittings ORDER BY id")).rows, fittingBefore);
    assert.deepEqual((await pg.query("SELECT * FROM users ORDER BY id")).rows, usersBefore);
    assert.deepEqual((await pg.query("SELECT * FROM characters ORDER BY id")).rows, charactersBefore);
    assert.deepEqual((await pg.query("SELECT user_id FROM pap_records")).rows, [{ user_id: 3 }]);
    assert.deepEqual((await pg.query("SELECT owner_id FROM pap_market_orders")).rows, [{ owner_id: 3 }]);
    assert.deepEqual((await pg.query("SELECT author_user_id,body FROM forum_posts")).rows[0], { author_user_id: 3, body: "Original post" });
    assert.deepEqual((await pg.query("SELECT author_user_id,body FROM forum_replies")).rows[0], { author_user_id: 3, body: "Original reply" });
    assert.deepEqual((await pg.query("SELECT owner_user_id,data_base64 FROM forum_attachments")).rows[0], { owner_user_id: 3, data_base64: "YQ==" });
  } finally {
    await pg.exec("DROP TRIGGER fail_test_orphan_delete ON users; DROP FUNCTION fail_test_orphan_delete()");
  }
});

test("real duty OAuth callback is one-use, preserves login tokens, and only creates a dedicated connection", async () => {
  dutyTokenFixture = true;
  const userBefore = (await pg.query("SELECT * FROM users WHERE id=1")).rows[0];
  const charactersBefore = (await pg.query("SELECT * FROM characters ORDER BY id")).rows;
  const response = await fetch(`${origin}/auth/eve/duty?characterId=1`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const state = new URL(response.headers.get("location")!).searchParams.get("state");
  assert.equal(currentSession.eveOauthFlow, "duty");
  assert.ok(state);
  const approved = await fetch(`${origin}/auth/eve/callback?code=fixture-code&state=${state}`, { redirect: "manual" });
  assert.equal(approved.headers.get("location"), "/duty-pap?connected=1");
  assert.equal(currentSession.eveOauthState, undefined);
  assert.equal(currentSession.eveOauthFlow, undefined);
  assert.equal(currentSession.dutyPapAuthorization, undefined);
  assert.deepEqual((await pg.query("SELECT * FROM users WHERE id=1")).rows[0], userBefore);
  assert.deepEqual((await pg.query("SELECT * FROM characters ORDER BY id")).rows, charactersBefore);
  const rows = (await pg.query("SELECT user_id,character_id,enabled,version FROM duty_pap_connections")).rows;
  assert.deepEqual(rows, [{ user_id: 1, character_id: 1, enabled: true, version: 0 }]);
  assert.equal((await pg.query("SELECT id FROM duty_pap_rules")).rows.length, 0);
  assert.equal((await pg.query("SELECT id FROM duty_pap_awards")).rows.length, 0);
  const replay = await fetch(`${origin}/auth/eve/callback?code=fixture-code&state=${state}`, { redirect: "manual" });
  assert.notEqual(replay.headers.get("location"), "/duty-pap?connected=1");
  assert.deepEqual((await pg.query("SELECT user_id,character_id,enabled,version FROM duty_pap_connections")).rows, rows);
});

test("real duty OAuth denial consumes state and mismatched game character cannot authorize", async () => {
  await fetch(`${origin}/auth/eve/duty?characterId=1`, { redirect: "manual" });
  let state = currentSession.eveOauthState;
  const cancelled = await fetch(`${origin}/auth/eve/callback?error=access_denied&state=${state}`, { redirect: "manual" });
  assert.equal(cancelled.headers.get("location"), "/duty-pap?error=duty_cancelled");
  assert.equal(currentSession.eveOauthState, undefined);
  assert.equal(currentSession.dutyPapAuthorization, undefined);
  dutyTokenFixture = true;
  await fetch(`${origin}/auth/eve/duty?characterId=1`, { redirect: "manual" });
  state = currentSession.eveOauthState;
  ssoCharacter = { characterId: 102, characterName: "Home alt", corporationId: 1001 };
  const mismatched = await fetch(`${origin}/auth/eve/callback?code=fixture-code&state=${state}`, { redirect: "manual" });
  assert.equal(mismatched.headers.get("location"), "/duty-pap?error=duty_character");
  assert.equal((await pg.query("SELECT id FROM duty_pap_connections")).rows.length, 0);
});

test("real duty OAuth rejects foreign, unbound and another member's character before starting consent", async () => {
  for (const characterId of [2, 7, 999]) {
    const response = await fetch(`${origin}/auth/eve/duty?characterId=${characterId}`, { redirect: "manual" });
    assert.equal(response.status, 404);
    assert.equal(currentSession.dutyPapAuthorization, undefined);
  }
});

test("retention cleanup only affects expired home-corporation characters", async () => {
  await pg.exec(`
    UPDATE characters SET deleted_at='2026-01-01', retained_until='2026-04-01'
      WHERE eve_character_id IN (102, 202);
  `);
  assert.equal(await purgeExpiredDeletedCharacters(new Date("2026-09-24")), 1);
  assert.equal((await pg.query("SELECT id FROM characters WHERE eve_character_id=102")).rows.length, 0);
  assert.equal((await pg.query("SELECT id FROM characters WHERE eve_character_id=202")).rows.length, 1);
});

test("monthly sweep does not start deductions for a historical external corporation", async () => {
  await pg.exec(`
    UPDATE corporations SET activity_deduction_started_at='2026-09-01T00:00:00Z' WHERE id=1001;
    UPDATE corporations SET activity_deduction_started_at='2026-08-01T00:00:00Z' WHERE id=2002;
    UPDATE users SET corporation_joined_at='2026-01-01', redeemable_pap=42 WHERE id=2;
  `);
  assert.deepEqual(await settleDueActivityMonths(new Date("2026-09-24")), {
    settlementsCreated: 0, membersSettled: 0, totalPapDeducted: 0,
  });
  assert.equal((await pg.query<{ redeemable_pap: number }>("SELECT redeemable_pap FROM users WHERE id=2")).rows[0].redeemable_pap, 42);
  assert.equal((await pg.query("SELECT id FROM activity_monthly_settlements")).rows.length, 0);
});
