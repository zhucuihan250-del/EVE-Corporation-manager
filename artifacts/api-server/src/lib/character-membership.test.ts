import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { fetchVerifiedAffiliations, purgeExpiredDepartedCharacters, recordVerifiedCharacterMembership, synchronizeCharacterMemberships, verifiedMembershipFields } from "./character-membership";

const pg = new PGlite();
const database = drizzle(pg) as unknown as Parameters<typeof recordVerifiedCharacterMembership>[0];
const now = new Date("2026-10-10T00:00:00Z");
const affiliation = (rows: unknown, status = 200): typeof fetch => async () => new Response(JSON.stringify(rows), { status, headers: { "Content-Type": "application/json", Date: now.toUTCString() } });

before(async () => {
  await pg.exec(`
    CREATE TABLE corporation_roster_connections(corporation_id integer,character_id integer);
    CREATE TABLE corporation_wallet_connections(corporation_id integer,character_id integer);
    CREATE TABLE corporation_structure_connections(corporation_id integer,character_id integer);
    CREATE TABLE users (id serial PRIMARY KEY, eve_character_id integer, eve_character_name text, corporation_id integer, corporation_name text,
      corporation_joined_at timestamptz, access_token text, refresh_token text, token_expiry timestamptz, role text NOT NULL DEFAULT 'member',
      total_pap double precision NOT NULL DEFAULT 0, redeemable_pap double precision NOT NULL DEFAULT 0, locked_pap double precision NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE corporation_memberships (id serial PRIMARY KEY, user_id integer NOT NULL, corporation_id integer NOT NULL, role text NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE characters (id serial PRIMARY KEY, user_id integer, eve_character_id integer NOT NULL, eve_character_name text NOT NULL,
      corporation_id integer, corporation_name text, access_token text, refresh_token text, token_expiry timestamptz, is_main boolean NOT NULL DEFAULT false,
      deleted_at timestamptz, retained_until timestamptz, membership_status text NOT NULL DEFAULT 'unknown', actual_corporation_id integer,
      membership_checked_at timestamptz, corporation_left_at timestamptz, membership_retained_until timestamptz, retention_corporation_id integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  `);
});
after(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec(`TRUNCATE users, characters, corporation_memberships,corporation_roster_connections,corporation_wallet_connections,corporation_structure_connections RESTART IDENTITY;
    INSERT INTO corporation_roster_connections VALUES(1001,101),(2002,201);
    INSERT INTO corporation_wallet_connections VALUES(1001,101),(2002,201);
    INSERT INTO corporation_structure_connections VALUES(1001,101),(2002,201);
    INSERT INTO users(id,eve_character_id,eve_character_name,corporation_id,refresh_token,total_pap,redeemable_pap,updated_at)
      VALUES (1,101,'Home pilot',1001,'fixture-token',8,8,'2026-01-01T00:00:00Z'),(2,201,'Unrelated pilot',2002,'fixture-token',5,5,'2026-01-01T00:00:00Z');
    INSERT INTO corporation_memberships(user_id,corporation_id) VALUES (1,1001),(2,2002);
    INSERT INTO characters(user_id,eve_character_id,eve_character_name,corporation_id,is_main,refresh_token,updated_at)
      VALUES (1,101,'Home pilot',1001,true,'fixture-token','2026-01-01T00:00:00Z'),(2,201,'Unrelated pilot',2002,true,'fixture-token','2026-01-01T00:00:00Z');
  `);
});

test("three calendar months retain time and clamp month-end and leap-day correctly", () => {
  assert.equal(verifiedMembershipFields(1001, 2002, new Date("2026-01-31T12:30:00Z")).membershipRetainedUntil?.toISOString(), "2026-04-30T12:30:00.000Z");
  assert.equal(verifiedMembershipFields(1001, 2002, new Date("2023-11-30T12:30:00Z")).membershipRetainedUntil?.toISOString(), "2024-02-29T12:30:00.000Z");
});

test("affiliation input rejects missing, duplicate, invalid and unrequested results", async () => {
  const result = await fetchVerifiedAffiliations([101,102,103], affiliation([
    {character_id:101,corporation_id:1001},{character_id:101,corporation_id:2002},
    {character_id:102,corporation_id:0},{character_id:999,corporation_id:2002},
  ]));
  assert.equal(result.size, 0);
  assert.equal((await fetchVerifiedAffiliations([101], affiliation({error:"outage"},503))).size,0);
});

test("verified departure preserves home FK and PAP while starting retention once", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,3003,now);
  let row = (await pg.query<Record<string,unknown>>("SELECT * FROM characters WHERE eve_character_id=101")).rows[0];
  assert.equal(row.corporation_id,1001);
  assert.equal(row.actual_corporation_id,3003);
  assert.equal(row.membership_status,"departed");
  assert.equal(new Date(row.membership_retained_until as string).toISOString(),"2027-01-10T00:00:00.000Z");
  await recordVerifiedCharacterMembership(database,1001,101,4004,new Date("2026-11-10T00:00:00Z"));
  row = (await pg.query<Record<string,unknown>>("SELECT * FROM characters WHERE eve_character_id=101")).rows[0];
  assert.equal(new Date(row.membership_retained_until as string).toISOString(),"2027-01-10T00:00:00.000Z");
  assert.equal((await pg.query<{redeemable_pap:number}>("SELECT redeemable_pap FROM users WHERE id=1")).rows[0].redeemable_pap,8);
});

test("rejoining cancels deletion window and restores home affiliation", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,3003,now);
  await recordVerifiedCharacterMembership(database,1001,101,1001,new Date("2027-01-01T00:00:00Z"));
  const row = (await pg.query<Record<string,unknown>>("SELECT * FROM characters WHERE eve_character_id=101")).rows[0];
  assert.equal(row.membership_status,"member");
  assert.equal(row.corporation_left_at,null);
  assert.equal(row.membership_retained_until,null);
  assert.equal(await purgeExpiredDepartedCharacters(database,1001,new Date("2027-02-01T00:00:00Z"),affiliation([{character_id:101,corporation_id:3003}])),0);
});

test("expired departure requires fresh valid ESI and keeps user wallet after purge", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,3003,new Date("2026-01-01T00:00:00Z"));
  assert.equal(await purgeExpiredDepartedCharacters(database,1001,now,affiliation({error:"outage"},503)),0);
  assert.equal((await pg.query("SELECT * FROM characters WHERE eve_character_id=101")).rows.length,1);
  assert.equal(await purgeExpiredDepartedCharacters(database,1001,now,affiliation([{character_id:101,corporation_id:3003}])),1);
  const user=(await pg.query<Record<string,unknown>>("SELECT * FROM users WHERE id=1")).rows[0];
  assert.equal(user.eve_character_id,null); assert.equal(user.refresh_token,null); assert.equal(user.redeemable_pap,8);
  assert.equal((await pg.query("SELECT * FROM characters WHERE eve_character_id=201")).rows.length,1);
  for(const table of ["corporation_roster_connections","corporation_wallet_connections","corporation_structure_connections"]) {
    assert.equal((await pg.query(`SELECT * FROM ${table} WHERE character_id=101`)).rows.length,0);
    assert.equal((await pg.query(`SELECT * FROM ${table} WHERE character_id=201`)).rows.length,1);
  }
});

test("fresh home affiliation at expiry rescues a rejoined character", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,3003,new Date("2026-01-01T00:00:00Z"));
  assert.equal(await purgeExpiredDepartedCharacters(database,1001,now,affiliation([{character_id:101,corporation_id:1001}])),0);
  assert.equal((await pg.query<{membership_status:string}>("SELECT membership_status FROM characters WHERE eve_character_id=101")).rows[0].membership_status,"member");
});

test("concurrent reauthorization while confirming expiry prevents deletion", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,3003,new Date("2026-01-01T00:00:00Z"));
  const race:typeof fetch=async () => {
    await recordVerifiedCharacterMembership(database,1001,101,1001,new Date("2026-10-10T00:01:00Z"));
    return new Response(JSON.stringify([{character_id:101,corporation_id:3003}]), {headers:{Date:now.toUTCString()}});
  };
  assert.equal(await purgeExpiredDepartedCharacters(database,1001,now,race),0);
});

test("expired characters are never purged using old, missing or malformed cache evidence", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,3003,new Date("2026-01-01T00:00:00Z"));
  for(const headers of [{},{Date:now.toUTCString(),Age:"3600"},{Date:now.toUTCString(),Age:"invalid"},{Date:"invalid"},{Date:new Date(now.getTime()+60_000).toUTCString()}]) {
    const fetcher:typeof fetch=async()=>new Response(JSON.stringify([{character_id:101,corporation_id:3003}]),{headers});
    assert.equal(await purgeExpiredDepartedCharacters(database,1001,now,fetcher),0);
  }
});

test("membership sweep includes authorized external alts and does not touch foreign accounts", async () => {
  await pg.exec("INSERT INTO characters(user_id,eve_character_id,eve_character_name,corporation_id,refresh_token) VALUES(1,102,'External alt',3003,'fixture-token')");
  const result=await synchronizeCharacterMemberships(database,1001,now,affiliation([{character_id:101,corporation_id:1001},{character_id:102,corporation_id:3003},{character_id:201,corporation_id:1001}]));
  assert.equal(result.checked,2); assert.equal(result.confirmed,2);
  assert.equal((await pg.query<{membership_status:string}>("SELECT membership_status FROM characters WHERE eve_character_id=102")).rows[0].membership_status,"departed");
  assert.equal((await pg.query<{membership_status:string}>("SELECT membership_status FROM characters WHERE eve_character_id=201")).rows[0].membership_status,"unknown");
});

test("late stale membership response cannot overwrite newer home authorization", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,1001,new Date("2026-10-11T00:00:00Z"));
  assert.equal(await recordVerifiedCharacterMembership(database,1001,101,3003,now),0);
  assert.equal((await pg.query<{membership_status:string}>("SELECT membership_status FROM characters WHERE eve_character_id=101")).rows[0].membership_status,"member");
});

test("fleet-discovered unbound orphan data never acquires an authorized-role deletion deadline", async () => {
  await pg.exec("UPDATE characters SET access_token=NULL,refresh_token=NULL WHERE eve_character_id=101; UPDATE users SET access_token=NULL,refresh_token=NULL WHERE id=1");
  assert.equal(await recordVerifiedCharacterMembership(database,1001,101,3003,now),0);
  const row=(await pg.query<{membership_status:string;membership_retained_until:Date|null}>("SELECT membership_status,membership_retained_until FROM characters WHERE eve_character_id=101")).rows[0];
  assert.equal(row.membership_status,"unknown"); assert.equal(row.membership_retained_until,null);
});

test("an older cached affiliation cannot undo a newer verified home authorization", async () => {
  await recordVerifiedCharacterMembership(database,1001,101,1001,now);
  const later = new Date(now.getTime()+30_000);
  const oldCache:typeof fetch=async()=>new Response(JSON.stringify([{character_id:101,corporation_id:3003}]),{headers:{Date:new Date(now.getTime()-30_000).toUTCString()}});
  const result=await synchronizeCharacterMemberships(database,1001,later,oldCache);
  assert.equal(result.confirmed,0);
  assert.equal((await pg.query<{membership_status:string}>("SELECT membership_status FROM characters WHERE eve_character_id=101")).rows[0].membership_status,"member");
});
