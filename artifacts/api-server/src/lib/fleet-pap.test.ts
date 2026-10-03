import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { fleetsTable, papRecordsTable } from "@workspace/db/schema";
import { createPapCurrencyFixture, PAP_FIXTURE_ACTORS } from "./pap-currency-test-fixture";
import { awardFleetPap, fleetCurrencyUpdate, lockFleetCurrency, validateFleetPapValue } from "./fleet-pap";
import { fleetPapCurrenciesMigration } from "../../../../lib/db/src/migrations/0031-fleet-pap-currencies";

const administrator = PAP_FIXTURE_ACTORS[1]!;
const member = PAP_FIXTURE_ACTORS[2]!;
const character = { id: 10, userId: 2, eveCharacterName: "测试成员" };

async function fixture() {
  const f = await createPapCurrencyFixture();
  await f.pg.exec(`
    CREATE TABLE fleets(id serial PRIMARY KEY,corporation_id integer NOT NULL,eve_fleet_id text,name text NOT NULL,fleet_commander text NOT NULL,pap_value real NOT NULL DEFAULT 1,is_active boolean NOT NULL DEFAULT true,fleet_function text NOT NULL DEFAULT 'general',identity_group_id integer,reimbursement_enabled boolean NOT NULL DEFAULT false,reimbursement_rule jsonb,started_at timestamptz,ended_at timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE pap_records(id serial PRIMARY KEY,corporation_id integer NOT NULL,user_id integer NOT NULL,character_id integer,fleet_id integer REFERENCES fleets(id) ON DELETE SET NULL,amount double precision NOT NULL,type text NOT NULL,reason text,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO fleets(corporation_id,eve_fleet_id,name,fleet_commander,pap_value) VALUES(1001,'100','历史舰队','测试 FC',1.2);
    INSERT INTO pap_records(corporation_id,user_id,character_id,fleet_id,amount,type,reason) VALUES(1001,2,10,1,1.2,'fleet','Historical award');
  `);
  const runFleetMigration = () => fleetPapCurrenciesMigration.up({ query: (statement: string) => f.pg.exec(statement) } as unknown as Parameters<typeof fleetPapCurrenciesMigration.up>[0]);
  const legacy = (await f.pg.query<{ value: number }>("SELECT pap_value::double precision AS value FROM fleets WHERE id=1")).rows[0]!.value;
  await runFleetMigration();
  const currency = (await f.service.createCurrency(administrator, { name: "管理员创建的测试 PAP", description: "", rate: "0.5", issuanceEnabled: true, conversionEnabled: true, requestId: randomUUID() })).currency;
  const createFleet = async (custom = true, value = 1.234567) => {
    const [fleet] = await f.database.insert(fleetsTable).values({ corporationId: 1001, eveFleetId: "200", name: "测试舰队", fleetCommander: "FC", papValue: value, papCurrencyId: custom ? currency.id : null, papCurrencyName: custom ? currency.name : null }).returning();
    return fleet;
  };
  const award = (fleetId: number, target = character) => f.database.transaction(tx => awardFleetPap(tx, { fleetId, corporationId: 1001, character: target, adminId: 1 }));
  return { ...f, legacy, runFleetMigration, currency, createFleet, award };
}

test("fleet amounts accept six exact decimals and reject invalid or overprecision values", () => {
  for (const amount of [0.000001, 0.5, 1.234567, 999999.123456, 1_000_000]) assert.doesNotThrow(() => validateFleetPapValue(amount));
  for (const amount of [0, -1, NaN, Infinity, 0.0000001, 0.1234567, 1.00000000001, 1_000_001]) assert.throws(() => validateFleetPapValue(amount));
});

test("0031 adds nullable currency fields, preserves historical values, and reruns safely", async () => {
  const f = await fixture();
  try {
    await f.runFleetMigration();
    const legacy = await f.database.select().from(fleetsTable).where(eq(fleetsTable.id, 1));
    assert.equal(legacy[0]!.papValue, f.legacy);
    assert.equal(legacy[0]!.papCurrencyId, null);
    const [record] = await f.database.select().from(papRecordsTable).where(eq(papRecordsTable.id, 1));
    assert.equal(record!.currencyId, null); assert.equal(record!.amount, 1.2);
    await f.createFleet();
    await assert.rejects(f.pg.query("DELETE FROM pap_currencies WHERE id=$1", [f.currency.id]));
  } finally { await f.close(); }
});

test("custom fleet awards update only their wallet and capture currency names", async () => {
  const f = await fixture();
  try {
    const fleet = await f.createFleet();
    const result = await f.award(fleet.id);
    assert.equal(result.awarded, true);
    assert.equal(result.record.currencyId, f.currency.id);
    assert.equal(result.record.currencyName, f.currency.name);
    const wallet = await f.service.getWallet(member);
    assert.equal(wallet.common.balance, "12.500000");
    assert.equal(wallet.wallets[0]!.balance, "1.234567");
    assert.equal(wallet.entries[0]!.type, "award");
    assert.equal(wallet.entries[0]!.currencyName, f.currency.name);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*)::int AS count FROM pap_ledger")).rows[0]!.count, 0);
  } finally { await f.close(); }
});

test("concurrent scan/manual retries award each character only once", async () => {
  const f = await fixture();
  try {
    const fleet = await f.createFleet();
    const outcomes = await Promise.all([f.award(fleet.id), f.award(fleet.id), f.award(fleet.id)]);
    assert.equal(outcomes.filter(result => result.awarded).length, 1);
    assert.equal((await f.service.getWallet(member)).wallets[0]!.balance, "1.234567");
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*)::int AS count FROM pap_records WHERE fleet_id=$1", [fleet.id])).rows[0]!.count, 1);
  } finally { await f.close(); }
});

test("common fleet awards retain the original balance and ledger workflow", async () => {
  const f = await fixture();
  try {
    const fleet = await f.createFleet(false, 0.25);
    const result = await f.award(fleet.id);
    assert.equal(result.record.currencyId, null);
    assert.equal((await f.service.getWallet(member)).common.balance, "12.750000");
    assert.equal((await f.service.getWallet(member)).wallets.length, 0);
    const row = (await f.pg.query<{ type: string; amount: number }>("SELECT type,amount FROM pap_ledger")).rows[0]!;
    assert.deepEqual(row, { type: "pap_earned", amount: 0.25 });
  } finally { await f.close(); }
});

test("paused/foreign currencies, inactive fleets and changed EVE IDs do not award", async () => {
  const f = await fixture();
  try {
    const fleet = await f.createFleet();
    await f.service.editCurrency(administrator, f.currency.id, { ...f.currency, version: f.currency.version, issuanceEnabled: false });
    await assert.rejects(f.award(fleet.id), { status: 409 });
    await assert.rejects(f.database.transaction(tx => lockFleetCurrency(tx, 2002, f.currency.id)), { status: 404 });
    await assert.rejects(f.database.transaction(tx => lockFleetCurrency(tx, 1001, 0.1)), { status: 400 });
    const common = await f.createFleet(false);
    await assert.rejects(f.database.transaction(tx => awardFleetPap(tx, { fleetId: common.id, corporationId: 1001, character, adminId: 1, expectedEveFleetId: "old" })), { status: 409 });
    await f.database.update(fleetsTable).set({ isActive: false }).where(eq(fleetsTable.id, common.id));
    await assert.rejects(f.award(common.id), { status: 400 });
    assert.equal((await f.service.getWallet(member)).wallets.length, 0);
    assert.equal((await f.service.getWallet(member)).common.balance, "12.500000");
  } finally { await f.close(); }
});

test("a fleet may change currency before an award, never after; unrelated edits remain allowed", async () => {
  const f = await fixture();
  try {
    const fleet = await f.createFleet(false);
    await f.database.transaction(async tx => {
      const [locked] = await tx.select().from(fleetsTable).where(eq(fleetsTable.id, fleet.id)).for("update");
      await tx.update(fleetsTable).set(await fleetCurrencyUpdate(tx, locked!, f.currency.id)).where(eq(fleetsTable.id, fleet.id));
    });
    await f.award(fleet.id);
    await assert.rejects(f.database.transaction(async tx => {
      const [locked] = await tx.select().from(fleetsTable).where(eq(fleetsTable.id, fleet.id)).for("update");
      return fleetCurrencyUpdate(tx, locked!, null);
    }), { status: 409 });
    await f.database.transaction(async tx => {
      const [locked] = await tx.select().from(fleetsTable).where(eq(fleetsTable.id, fleet.id)).for("update");
      assert.deepEqual(await fleetCurrencyUpdate(tx, locked!, f.currency.id), { papCurrencyId: f.currency.id });
    });
  } finally { await f.close(); }
});

test("batch scan transaction rolls back all new awards if a later member is invalid", async () => {
  const f = await fixture();
  try {
    const fleet = await f.createFleet();
    await assert.rejects(f.database.transaction(async tx => {
      await awardFleetPap(tx, { fleetId: fleet.id, corporationId: 1001, character, adminId: 1 });
      await awardFleetPap(tx, { fleetId: fleet.id, corporationId: 1001, character: { id: 11, userId: 4, eveCharacterName: "Foreign" }, adminId: 1 });
    }), { code: "PAP_MEMBER_NOT_FOUND" });
    assert.equal((await f.service.getWallet(member)).wallets.length, 0);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*)::int AS count FROM pap_records WHERE fleet_id=$1", [fleet.id])).rows[0]!.count, 0);
  } finally { await f.close(); }
});

test("contribution aggregates keep custom fleet attendance but sum only six-place common PAP", async () => {
  const f = await fixture();
  try {
    const pilot = { id: 11, userId: 3, eveCharacterName: "另一成员" };
    for (const value of [0.1, 0.2]) await f.award((await f.createFleet(false, value)).id, pilot);
    await f.award((await f.createFleet(true, 500)).id, pilot);
    // Same PostgreSQL aggregate used by the dashboard and tactical summaries:
    // currency filters apply to the sum, not the attendance row set.
    const [summary] = await f.database.select({
      fleetCount: sql<number>`COUNT(DISTINCT ${papRecordsTable.fleetId})::int`,
      pap: sql<number>`ROUND(COALESCE(SUM(${papRecordsTable.amount}) FILTER (WHERE ${papRecordsTable.currencyId} IS NULL), 0)::numeric, 6)::double precision`,
    }).from(papRecordsTable).where(and(eq(papRecordsTable.corporationId, 1001), eq(papRecordsTable.userId, 3)));
    assert.deepEqual(summary, { fleetCount: 3, pap: 0.3 });
    const history = await f.pg.query<{ pap: number }>("SELECT ROUND(SUM(amount)::numeric,6)::double precision AS pap FROM pap_records WHERE user_id=3 AND corporation_id=1001 AND currency_id IS NULL AND amount>0 GROUP BY DATE(created_at)");
    assert.deepEqual(history.rows, [{ pap: 0.3 }]);
  } finally { await f.close(); }
});
