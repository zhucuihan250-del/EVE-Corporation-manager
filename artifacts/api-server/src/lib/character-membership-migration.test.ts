import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { characterMembershipRetentionMigration } from "../../../../lib/db/src/migrations/0035-character-membership-retention";

async function database() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE corporations(id integer PRIMARY KEY);
    CREATE TABLE users(id integer PRIMARY KEY,redeemable_pap double precision NOT NULL);
    CREATE TABLE characters(
      id integer PRIMARY KEY,user_id integer REFERENCES users(id) ON DELETE CASCADE,
      corporation_id integer REFERENCES corporations(id) ON DELETE SET NULL,
      eve_character_id integer NOT NULL,eve_character_name text NOT NULL,
      deleted_at timestamptz,retained_until timestamptz);
    CREATE UNIQUE INDEX characters_corporation_id_unique ON characters(corporation_id,id);
    CREATE TABLE identity_group_applications(
      id integer PRIMARY KEY,corporation_id integer NOT NULL REFERENCES corporations(id),
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id integer NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'approved',
      CONSTRAINT identity_group_applications_corporation_character_fk
        FOREIGN KEY(corporation_id,character_id) REFERENCES characters(corporation_id,id) ON DELETE RESTRICT);
    CREATE TABLE identity_group_memberships(
      id integer PRIMARY KEY,corporation_id integer NOT NULL REFERENCES corporations(id),
      user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id integer REFERENCES characters(id) ON DELETE SET NULL,
      CONSTRAINT identity_group_memberships_corporation_character_fk
        FOREIGN KEY(corporation_id,character_id) REFERENCES characters(corporation_id,id) ON DELETE RESTRICT);
    CREATE TABLE pap_records(
      id integer PRIMARY KEY,user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      character_id integer REFERENCES characters(id) ON DELETE SET NULL,amount double precision NOT NULL);
    INSERT INTO corporations VALUES(1001),(2002);
    INSERT INTO users VALUES(1,13.25),(2,9.5);
    INSERT INTO characters(id,user_id,corporation_id,eve_character_id,eve_character_name,deleted_at,retained_until)
      VALUES(10,1,1001,90010,'已授权主角色',NULL,NULL),(11,1,1001,90011,'手动解绑角色','2026-09-01T00:00:00Z','2026-12-01T00:00:00Z'),
        (20,2,2002,90020,'历史外团角色',NULL,NULL);
    INSERT INTO identity_group_applications(id,corporation_id,user_id,character_id)
      VALUES(100,1001,1,10),(200,2002,2,20);
    INSERT INTO identity_group_memberships VALUES(100,1001,1,10),(200,2002,2,20);
    INSERT INTO pap_records VALUES(1,1,10,3.25),(2,2,20,9.5);
  `);
  await characterMembershipRetentionMigration.up({
    query: (sql: string) => pg.exec(sql),
  } as unknown as Parameters<typeof characterMembershipRetentionMigration.up>[0]);
  return pg;
}

test("membership migration does not infer a departure or backdate a retention window", async () => {
  const pg = await database();
  try {
    const result = await pg.query("SELECT membership_status,membership_checked_at,corporation_left_at,actual_corporation_id,retention_corporation_id,membership_retained_until FROM characters ORDER BY id");
    assert.equal(result.rows.length, 3);
    for (const row of result.rows) {
      assert.deepEqual(row, {
        membership_status: "unknown",membership_checked_at: null,corporation_left_at: null,
        actual_corporation_id: null,retention_corporation_id: null,membership_retained_until: null,
      });
    }
    assert.deepEqual((await pg.query("SELECT id,redeemable_pap FROM users ORDER BY id")).rows, [
      { id: 1,redeemable_pap: 13.25 },{ id: 2,redeemable_pap: 9.5 },
    ]);
  } finally { await pg.close(); }
});

test("character purge preserves identity applications, membership, PAP and accounts with applicant snapshots", async () => {
  const pg = await database();
  try {
    await pg.query("DELETE FROM characters WHERE id=10");
    assert.deepEqual((await pg.query("SELECT id,corporation_id,user_id,character_id,status,applicant_character_name_snapshot,applicant_eve_character_id_snapshot FROM identity_group_applications WHERE id=100")).rows, [{
      id: 100,corporation_id: 1001,user_id: 1,character_id: null,status: "approved",
      applicant_character_name_snapshot: "已授权主角色",applicant_eve_character_id_snapshot: 90010,
    }]);
    assert.deepEqual((await pg.query("SELECT * FROM identity_group_memberships WHERE id=100")).rows, [{ id: 100,corporation_id: 1001,user_id: 1,character_id: null }]);
    assert.deepEqual((await pg.query("SELECT * FROM pap_records WHERE id=1")).rows, [{ id: 1,user_id: 1,character_id: null,amount: 3.25 }]);
    assert.deepEqual((await pg.query("SELECT id,redeemable_pap FROM users ORDER BY id")).rows, [{ id: 1,redeemable_pap: 13.25 },{ id: 2,redeemable_pap: 9.5 }]);
    assert.deepEqual((await pg.query("SELECT id FROM characters ORDER BY id")).rows, [{ id: 11 },{ id: 20 }]);
    assert.equal((await pg.query<{ character_id: number }>("SELECT character_id FROM identity_group_applications WHERE id=200")).rows[0]?.character_id, 20);
  } finally { await pg.close(); }
});

test("targeted SET NULL still rejects cross-corporation character references in both identity tables", async () => {
  const pg = await database();
  try {
    for (const table of ["identity_group_applications", "identity_group_memberships"]) {
      await assert.rejects(pg.query(`INSERT INTO ${table}(id,corporation_id,user_id,character_id) VALUES(300,1001,1,20)`));
      await assert.rejects(pg.query(`UPDATE ${table} SET character_id=20 WHERE id=100`));
    }
    // A linked character cannot silently change its tenant through an update.
    await assert.rejects(pg.query("UPDATE characters SET corporation_id=2002 WHERE id=10"));
    await pg.query("UPDATE characters SET actual_corporation_id=2002,membership_status='departed' WHERE id=10");
    assert.equal((await pg.query<{ corporation_id: number }>("SELECT corporation_id FROM characters WHERE id=10")).rows[0]?.corporation_id, 1001);
  } finally { await pg.close(); }
});

test("membership evidence validates status and home-corporation retention ownership", async () => {
  const pg = await database();
  try {
    await assert.rejects(pg.query("UPDATE characters SET membership_status='missing' WHERE id=10"));
    await assert.rejects(pg.query("UPDATE characters SET retention_corporation_id=9999 WHERE id=10"));
    await pg.query("UPDATE characters SET membership_status='member',actual_corporation_id=1001,membership_checked_at='2026-10-10' WHERE id=10");
    await pg.query("UPDATE characters SET membership_status='departed',actual_corporation_id=9999,retention_corporation_id=1001,corporation_left_at='2026-10-10',membership_retained_until='2027-01-10' WHERE id=10");
    assert.equal((await pg.query<{ actual_corporation_id: number }>("SELECT actual_corporation_id FROM characters WHERE id=10")).rows[0]?.actual_corporation_id, 9999);
  } finally { await pg.close(); }
});

test("manual unlink retention remains independent from the departure retention fields", async () => {
  const pg = await database();
  try {
    await pg.query("UPDATE characters SET membership_status='member',membership_checked_at='2026-10-10',actual_corporation_id=1001 WHERE id=11");
    const row = (await pg.query<{ deleted_at: Date;retained_until: Date;membership_retained_until: Date | null }>("SELECT deleted_at,retained_until,membership_retained_until FROM characters WHERE id=11")).rows[0]!;
    assert.equal(row.deleted_at.toISOString(), "2026-09-01T00:00:00.000Z");
    assert.equal(row.retained_until.toISOString(), "2026-12-01T00:00:00.000Z");
    assert.equal(row.membership_retained_until, null);
  } finally { await pg.close(); }
});
