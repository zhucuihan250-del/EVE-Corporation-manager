import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { automaticDutyPapMigration } from "../../../../lib/db/src/migrations/0033-automatic-duty-pap";
import { dutyPapAwardsTable, dutyPapConnectionsTable, dutyPapProgressTable, dutyPapRulesTable } from "../../../../lib/db/src/schema/duty_pap";

async function fixture() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE corporations(id integer PRIMARY KEY);
    CREATE TABLE users(id integer PRIMARY KEY, corporation_id integer, total_pap double precision NOT NULL, redeemable_pap double precision NOT NULL, locked_pap double precision NOT NULL);
    CREATE TABLE characters(id integer PRIMARY KEY, corporation_id integer REFERENCES corporations(id), user_id integer REFERENCES users(id) ON DELETE SET NULL, deleted_at timestamptz);
    CREATE UNIQUE INDEX characters_corporation_id_unique ON characters(corporation_id,id);
    CREATE TABLE pap_currencies(id integer PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id), name text NOT NULL, rate numeric(13,6) NOT NULL);
    CREATE UNIQUE INDEX pap_currencies_corporation_id_unique ON pap_currencies(corporation_id,id);
    CREATE TABLE pap_records(id integer PRIMARY KEY, corporation_id integer NOT NULL, user_id integer REFERENCES users(id) ON DELETE SET NULL, amount double precision NOT NULL);
    INSERT INTO corporations VALUES (1001),(2002);
    INSERT INTO users VALUES (1,1001,13.125,10.500001,2.125),(2,1001,0,0,0),(3,2002,8.25,7.000002,1);
    INSERT INTO characters VALUES (11,1001,1,NULL),(12,1001,1,NULL),(13,1001,2,NULL),(31,2002,3,NULL);
    INSERT INTO pap_currencies VALUES (7,1001,'管理员已有币种',0.333333),(8,2002,'其他军团币种',1.25);
    INSERT INTO pap_records VALUES (1,1001,1,0.25),(2,2002,3,0.125);
  `);
  const statements: string[] = [];
  const migrate = () => automaticDutyPapMigration.up({
    query: async (statement: string) => { statements.push(statement); return pg.exec(statement); },
  } as unknown as Parameters<typeof automaticDutyPapMigration.up>[0]);
  await migrate();
  const addRule = async (id = 1, corporationId = 1001, currencyId: number | null = null, enabled = true, fleetId = "1099511000001") => {
    await pg.query(`INSERT INTO duty_pap_rules(id,corporation_id,name,eve_fleet_id,currency_id,minutes_per_award,award_amount,daily_cap,enabled,create_request_id,created_by)
      VALUES($1,$2,'测试认可值守舰队',$3,$4,60,0.125000,0.250000,$5,$6,1)`, [id, corporationId, fleetId, currencyId, enabled, `rule-request-${id}`]);
  };
  const addAward = async (index = 1, day = "2026-10-04", currencyId: number | null = null) => {
    await pg.query(`INSERT INTO duty_pap_awards(corporation_id,rule_id,user_id,user_name,character_name,day,award_index,rule_version,rule_name,eve_fleet_id,minutes_per_award,amount,currency_id,currency_name,pap_record_id)
      VALUES(1001,1,1,'历史账号名','历史角色名',$1,$2,0,'历史规则名','1099511000001',60,0.125000,$3,'通用 PAP',1)`, [day, index, currencyId]);
  };
  return { pg, migrate, statements, addRule, addAward, close: () => pg.close() };
}

test("duty migration is additive and repeatable without seeding rules, connections, currencies or PAP", async () => {
  const f = await fixture();
  try {
    await f.migrate();
    assert.equal(automaticDutyPapMigration.id, "0033_automatic_duty_pap");
    for (const table of ["duty_pap_rules", "duty_pap_connections", "duty_pap_progress", "duty_pap_awards"]) {
      assert.equal((await f.pg.query<{ n: number }>(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n, 0);
    }
    assert.deepEqual((await f.pg.query("SELECT * FROM users ORDER BY id")).rows, [
      { id: 1, corporation_id: 1001, total_pap: 13.125, redeemable_pap: 10.500001, locked_pap: 2.125 },
      { id: 2, corporation_id: 1001, total_pap: 0, redeemable_pap: 0, locked_pap: 0 },
      { id: 3, corporation_id: 2002, total_pap: 8.25, redeemable_pap: 7.000002, locked_pap: 1 },
    ]);
    assert.deepEqual((await f.pg.query("SELECT id,name,rate::text FROM pap_currencies ORDER BY id")).rows, [
      { id: 7, name: "管理员已有币种", rate: "0.333333" }, { id: 8, name: "其他军团币种", rate: "1.250000" },
    ]);
    assert.deepEqual((await f.pg.query("SELECT * FROM pap_records ORDER BY id")).rows, [
      { id: 1, corporation_id: 1001, user_id: 1, amount: 0.25 }, { id: 2, corporation_id: 2002, user_id: 3, amount: 0.125 },
    ]);
    for (const statement of f.statements) {
      assert.doesNotMatch(statement, /\b(?:UPDATE|INSERT\s+INTO|DELETE\s+FROM|DROP|TRUNCATE|ALTER)\b/i);
    }
  } finally { await f.close(); }
});

test("duty migration matches every Drizzle column, nullability, explicit index and check constraint", async () => {
  const f = await fixture();
  try {
    for (const table of [dutyPapRulesTable, dutyPapConnectionsTable, dutyPapProgressTable, dutyPapAwardsTable]) {
      const config = getTableConfig(table);
      const actual = (await f.pg.query<{ column_name: string; is_nullable: string }>(
        "SELECT column_name,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY column_name", [config.name],
      )).rows;
      assert.deepEqual(actual.map(row => row.column_name), config.columns.map(column => column.name).sort());
      for (const column of config.columns) {
        assert.equal(actual.find(row => row.column_name === column.name)?.is_nullable, column.notNull ? "NO" : "YES", `${config.name}.${column.name}`);
      }
      const indexes = (await f.pg.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename=$1", [config.name])).rows.map(row => row.indexname);
      for (const index of config.indexes) assert.ok(indexes.includes(index.config.name!), `${config.name} missing ${index.config.name}`);
      const checks = (await f.pg.query<{ conname: string }>("SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c'", [config.name])).rows.map(row => row.conname);
      for (const check of config.checks) assert.ok(checks.includes(check.name), `${config.name} missing ${check.name}`);
    }
  } finally { await f.close(); }
});

test("disabled-by-default rules and authorizations cannot silently opt members into sampling", async () => {
  const f = await fixture();
  try {
    await f.pg.exec(`INSERT INTO duty_pap_rules(corporation_id,name,eve_fleet_id,minutes_per_award,award_amount,daily_cap,create_request_id) VALUES(1001,'默认暂停','1099511000001',60,1,2,'paused-default');
      INSERT INTO duty_pap_connections(corporation_id,user_id,character_id) VALUES(1001,1,11);`);
    assert.deepEqual((await f.pg.query("SELECT enabled,require_undocked,solar_system_ids,ship_type_ids,version FROM duty_pap_rules")).rows,
      [{ enabled: false, require_undocked: true, solar_system_ids: [], ship_type_ids: [], version: 0 }]);
    assert.deepEqual((await f.pg.query("SELECT enabled,access_token,refresh_token,scopes,last_status,version FROM duty_pap_connections")).rows,
      [{ enabled: false, access_token: null, refresh_token: null, scopes: [], last_status: "authorization_required", version: 0 }]);
  } finally { await f.close(); }
});

test("one character connection per account and only one active rule per corporation/fleet", async () => {
  const f = await fixture();
  try {
    await f.addRule();
    await assert.rejects(f.addRule(2));
    await f.addRule(3, 1001, null, false);
    await f.addRule(4, 2002);
    await f.pg.exec("INSERT INTO duty_pap_connections(corporation_id,user_id,character_id) VALUES(1001,1,11)");
    await assert.rejects(f.pg.exec("INSERT INTO duty_pap_connections(corporation_id,user_id,character_id) VALUES(1001,1,12)"));
    await f.pg.exec("INSERT INTO duty_pap_connections(corporation_id,user_id,character_id) VALUES(1001,2,13)");
  } finally { await f.close(); }
});

test("cross-corporation currencies and rules cannot back an automatic award or progress record", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.addRule(1, 1001, 8));
    await f.addRule(1, 1001, 7);
    await f.addRule(2, 2002, 8);
    await f.pg.exec("INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version) VALUES(1001,1,1,'2026-10-04',0)");
    await assert.rejects(f.pg.exec("INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version) VALUES(2002,1,3,'2026-10-04',0)"));
    await assert.rejects(f.addAward(1, "2026-10-04", 8));
    await f.addAward(1, "2026-10-04", 7);
    await assert.rejects(f.pg.exec("UPDATE duty_pap_awards SET corporation_id=2002 WHERE rule_id=1 AND corporation_id=1001"));
  } finally { await f.close(); }
});

test("progress UTC buckets and award indexes retain database-level retry protection", async () => {
  const f = await fixture();
  try {
    await f.addRule();
    await f.pg.exec("INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version,paid_amount) VALUES(1001,1,1,'2026-10-04',0,0.125000)");
    await assert.rejects(f.pg.exec("INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version) VALUES(1001,1,1,'2026-10-04',1)"));
    await f.pg.exec("INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version) VALUES(1001,1,1,'2026-10-05',0)");
    await f.addAward();
    await assert.rejects(f.addAward());
    await f.addAward(2);
    await f.addAward(1, "2026-10-05");
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::integer n FROM duty_pap_awards")).rows[0].n, 3);
    assert.equal((await f.pg.query<{ paid_amount: string }>("SELECT paid_amount::text FROM duty_pap_progress WHERE day='2026-10-04'")).rows[0].paid_amount, "0.125000");
  } finally { await f.close(); }
});

test("authorization references do not block verified character departure, nullable affiliation or soft unlink", async () => {
  const f = await fixture();
  try {
    await f.pg.exec("INSERT INTO duty_pap_connections(corporation_id,user_id,character_id) VALUES(1001,1,11)");
    await f.pg.exec("UPDATE characters SET corporation_id=2002 WHERE id=11");
    await f.pg.exec("UPDATE characters SET corporation_id=NULL WHERE id=11");
    await f.pg.exec("UPDATE characters SET user_id=NULL,deleted_at=now() WHERE id=11");
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::integer n FROM duty_pap_connections")).rows[0].n, 1);
    // Eligibility is revalidated by the service; a hard purge removes credentials.
    await f.pg.exec("DELETE FROM characters WHERE id=11");
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::integer n FROM duty_pap_connections")).rows[0].n, 0);
  } finally { await f.close(); }
});

test("hard account and PAP-record deletion removes credentials but preserves award name and amount snapshots", async () => {
  const f = await fixture();
  try {
    await f.addRule();
    await f.addAward();
    await f.pg.exec(`INSERT INTO duty_pap_connections(corporation_id,user_id,character_id) VALUES(1001,1,11);
      INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version) VALUES(1001,1,1,'2026-10-04',0);
      DELETE FROM pap_records WHERE id=1;
      DELETE FROM users WHERE id=1;`);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::integer n FROM duty_pap_connections")).rows[0].n, 0);
    assert.equal((await f.pg.query<{ n: number }>("SELECT count(*)::integer n FROM duty_pap_progress")).rows[0].n, 0);
    assert.deepEqual((await f.pg.query("SELECT user_id,user_name,character_name,rule_name,amount::text,pap_record_id FROM duty_pap_awards")).rows,
      [{ user_id: null, user_name: "历史账号名", character_name: "历史角色名", rule_name: "历史规则名", amount: "0.125000", pap_record_id: null }]);
    assert.equal((await f.pg.query<{ created_by: number | null }>("SELECT created_by FROM duty_pap_rules")).rows[0].created_by, null);
  } finally { await f.close(); }
});

test("invalid negative progress, amounts and orphan rules are rejected before any account balance changes", async () => {
  const f = await fixture();
  try {
    await f.addRule();
    for (const update of ["award_amount=0", "award_amount=-1", "daily_cap=0", "daily_cap=1000001", "minutes_per_award=0", "minutes_per_award=1441", "version=-1"]) {
      await assert.rejects(f.pg.exec(`UPDATE duty_pap_rules SET ${update} WHERE id=1`));
    }
    await assert.rejects(f.pg.exec("INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version,eligible_seconds) VALUES(1001,1,1,'2026-10-04',0,-1)"));
    await assert.rejects(f.pg.exec("INSERT INTO duty_pap_progress(corporation_id,rule_id,user_id,day,rule_version) VALUES(1001,999,1,'2026-10-04',0)"));
    assert.deepEqual((await f.pg.query("SELECT total_pap,redeemable_pap,locked_pap FROM users WHERE id=1")).rows,
      [{ total_pap: 13.125, redeemable_pap: 10.500001, locked_pap: 2.125 }]);
  } finally { await f.close(); }
});
