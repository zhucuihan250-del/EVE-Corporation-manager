import assert from "node:assert/strict";
import test from "node:test";
import { createDutyPapFixture, DUTY_ACTORS, dutyRuleInput } from "./duty-pap-test-fixture";
import { DUTY_PAP_SCOPES, dutyPapElapsed, dutyPapRuleInput } from "./duty-pap-rules";
import { createDutyPapService, mergeDutyPapAccounts } from "./duty-pap-service";
import { randomUUID } from "node:crypto";

const admin = DUTY_ACTORS[1]!, member = DUTY_ACTORS[2]!, other = DUTY_ACTORS[3]!, foreign = DUTY_ACTORS[4]!;
test("six-place decimal and context/date continuity rules never round or backfill", () => {
  assert.equal(dutyPapRuleInput(dutyRuleInput()).awardAmount, "0.100000");
  for (const input of [{ awardAmount: "0.0000001" }, { dailyCap: "0.09" }, { minutesPerAward: 0 }, { solarSystemIds: Array(51).fill(30000142) }, { actorUserId: 2 }]) assert.throws(() => dutyPapRuleInput(dutyRuleInput(input)));
  const start = new Date("2026-10-04T10:00:00Z");
  assert.equal(dutyPapElapsed(start, new Date(+start + 60_000), true, true), 60);
  assert.equal(dutyPapElapsed(start, new Date(+start + 120_000), true, true), 90);
  assert.equal(dutyPapElapsed(start, new Date(+start + 151_000), true, true), 0);
  assert.equal(dutyPapElapsed(start, new Date(+start + 60_000), false, true), 0);
  assert.equal(dutyPapElapsed(new Date("2026-10-04T23:59:50Z"), new Date("2026-10-05T00:00:20Z"), true, true), 0);
});
test("migration is additive, idempotent and seeds no authorizations, rules or custom PAP", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.runDutyMigration();
    const result = await f.pg.query<{ count: number }>("SELECT (SELECT count(*) FROM duty_pap_rules)+(SELECT count(*) FROM duty_pap_connections)+(SELECT count(*) FROM duty_pap_progress)+(SELECT count(*) FROM duty_pap_awards)+(SELECT count(*) FROM pap_currencies) AS count");
    assert.equal(result.rows[0]!.count, 0);
    assert.equal((await f.pg.query<{ amount: number }>("SELECT redeemable_pap AS amount FROM users WHERE id=2")).rows[0]!.amount, 12.5);
  } finally { await f.close(); }
});
test("admin/controller only rules, forced-paused create, replay, version and cross-corporation editing guards", async () => {
  const f = await createDutyPapFixture();
  try {
    for (const actor of [member, DUTY_ACTORS[5]!]) await assert.rejects(f.service.createRule(actor, dutyRuleInput()), { code: "DUTY_PAP_ADMIN_REQUIRED" });
    const body = dutyRuleInput({ enabled: true }), result = await f.service.createRule(admin, body);
    assert.equal(result.rule!.enabled, false);
    assert.equal((await f.service.createRule(admin, body)).replayed, true);
    await assert.rejects(f.service.createRule(admin, { ...body, name: "Changed" }), { code: "DUTY_PAP_REQUEST_CONFLICT" });
    await assert.rejects(f.service.updateRule(foreign, result.rule!.id, { ...body, version: 0 }), { code: "DUTY_PAP_RULE_NOT_FOUND" });
    const enabled = await f.service.updateRule(admin, result.rule!.id, { ...body, version: 0 });
    await assert.rejects(f.service.updateRule(admin, result.rule!.id, { ...body, version: 0 }), { code: "DUTY_PAP_VERSION_CONFLICT" });
    assert.equal(enabled.rule!.enabled, true);
    await assert.rejects(f.service.createRule(admin, dutyRuleInput({ solarSystemIds: [99999999] })), { code: "DUTY_PAP_INVALID_SYSTEM" });
    await assert.rejects(f.service.createRule(admin, dutyRuleInput({ shipTypeIds: [34] })), { code: "DUTY_PAP_INVALID_SHIP" });
  } finally { await f.close(); }
});
test("independent member authorization checks owner/corp/scopes and stale callback, preserving existing skill tokens", async () => {
  const f = await createDutyPapFixture();
  try {
    await assert.rejects(f.authorize(2, 12), { code: "DUTY_PAP_CHARACTER_NOT_FOUND" });
    await assert.rejects(f.authorize(2, 20), { code: "DUTY_PAP_CHARACTER_NOT_FOUND" });
    await assert.rejects(f.service.authorizeConnection(member, { characterId: 10, accessToken: "a", refreshToken: "r", tokenExpiry: new Date(+f.now() + 60_000), scopes: [], expectedVersion: null }), { code: "DUTY_PAP_AUTHORIZATION_REQUIRED" });
    const initial = await f.authorize();
    assert.equal(initial.connection!.enabled, true);
    await assert.rejects(f.authorize(2, 11), { code: "DUTY_PAP_VERSION_CONFLICT" });
    await f.authorize(2, 11, initial.connection!.version);
    const tokens = await f.pg.query<{ access_token: string; refresh_token: string }>("SELECT access_token,refresh_token FROM characters WHERE id=10");
    assert.equal(tokens.rows[0]!.access_token, "existing-skill-access");
    assert.equal(tokens.rows[0]!.refresh_token, "existing-skill-refresh");
  } finally { await f.close(); }
});
test("external FC fleet identity uses only own observations, common awards are atomic and final cap is partial", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule(); await f.authorize();
    assert.equal((await f.sample()).creditedSeconds, 0);
    for (let i = 0; i < 4; i++) { f.advance(60); await f.sample(); }
    const row = (await f.pg.query<{ balance: number; locked: number }>("SELECT redeemable_pap AS balance,locked_pap AS locked FROM users WHERE id=2")).rows[0]!;
    assert.equal(row.balance, 12.75); assert.equal(row.locked, 2);
    assert.deepEqual((await f.pg.query<{ amount: string }>("SELECT amount::text FROM duty_pap_awards ORDER BY id")).rows.map(row => row.amount), ["0.100000", "0.100000", "0.050000"]);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM pap_records WHERE user_id=2")).rows[0]!.count, 3);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM pap_ledger WHERE user_id=2")).rows[0]!.count, 3);
    const view = await f.service.memberDashboard(member);
    assert.equal(view.rules[0]!.today.paidAmount, "0.250000"); assert.equal(view.connection!.status, "daily_cap");
  } finally { await f.close(); }
});
test("custom PAP is credited through the existing currency wallet, not the common PAP balance", async () => {
  const f = await createDutyPapFixture();
  try {
    const { currency } = await f.createService().createCurrency(admin, { name: "管理员自行创建值守积分", description: "", rate: "2", issuanceEnabled: true, conversionEnabled: true, requestId: randomUUID() });
    await f.createRule({ currencyId: currency!.id }); await f.authorize(); await f.sample(); f.advance(60); await f.sample();
    assert.equal((await f.pg.query<{ balance: number }>("SELECT redeemable_pap AS balance FROM users WHERE id=2")).rows[0]!.balance, 12.5);
    assert.equal((await f.pg.query<{ balance: string }>("SELECT balance::text FROM pap_currency_wallets WHERE user_id=2")).rows[0]!.balance, "0.100000");
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM pap_currency_ledger WHERE user_id=2 AND type='award'")).rows[0]!.count, 1);
    await f.pg.exec("UPDATE pap_currencies SET issuance_enabled=false"); f.advance(60);
    assert.equal((await f.sample()).status, "currency_paused");
  } finally { await f.close(); }
});
test("concurrent/restarted/late duplicate observations award once and preserve exact six-place arithmetic", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule({ awardAmount: "0.000001", dailyCap: "0.000002" }); await f.authorize(); await f.sample(); f.advance(60);
    const connection = await f.connection(), observation = f.observation();
    const freshService = createDutyPapService({ database: f.database, now: f.now });
    const outcomes = await Promise.all([f.service.processObservation(connection.id, connection.version, observation), freshService.processObservation(connection.id, connection.version, observation), f.service.processObservation(connection.id, connection.version, observation)]);
    assert.equal(outcomes.filter(result => result.awardedAmount === "0.000001").length, 1);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM duty_pap_awards")).rows[0]!.count, 1);
    f.advance(60); await freshService.processObservation(connection.id, connection.version, f.observation());
    assert.equal((await f.pg.query<{ balance: number }>("SELECT redeemable_pap AS balance FROM users WHERE id=2")).rows[0]!.balance, 12.500002);
  } finally { await f.close(); }
});
test("failure/offline/wrong fleet/filter/dock reset continuity and recover without backfilling", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule({ minutesPerAward: 10, solarSystemIds: [30000142], shipTypeIds: [587] }); await f.authorize(); await f.sample();
    const failures = [{ valid: false, status: "unavailable", evidenceAt: null }, { valid: false, status: "offline", online: false }, { eveFleetId: "999" }, { solarSystemId: 30000144 }, { shipTypeId: 588 }, { docked: true }];
    for (const failure of failures) {
      f.advance(60); assert.equal((await f.sample(failure)).creditedSeconds, 0);
      f.advance(60); assert.equal((await f.sample()).creditedSeconds, 0);
      f.advance(60); assert.equal((await f.sample()).creditedSeconds, 60);
    }
    f.advance(151); assert.equal((await f.sample()).creditedSeconds, 0);
    f.advance(120); assert.equal((await f.sample()).creditedSeconds, 90);
  } finally { await f.close(); }
});
test("stale cache, old walltime and future samples do not accumulate; fresh recovery starts at zero", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule({ minutesPerAward: 10 }); await f.authorize(); await f.sample();
    const oldEvidence = f.now(); f.advance(60);
    assert.equal((await f.sample({ evidenceAt: oldEvidence })).status, "stale_data");
    f.advance(30); assert.equal((await f.sample()).creditedSeconds, 0);
    const oldObservation = f.observation(); f.advance(30); await f.sample();
    assert.equal((await f.sample(oldObservation)).ignored, true);
    f.advance(60); assert.equal((await f.sample({ evidenceAt: new Date(+f.now() - 91_000) })).creditedSeconds, 0);
    f.advance(60); assert.equal((await f.sample({ observedAt: new Date(+f.now() + 6000) })).ignored, true);
  } finally { await f.close(); }
});
test("UTC midnight resets period, does not credit crossing interval or apply yesterday's remainder", async () => {
  const f = await createDutyPapFixture();
  try {
    f.setTime("2026-10-04T23:58:00Z"); await f.createRule({ minutesPerAward: 2 }); await f.authorize(); await f.sample(); f.advance(60); await f.sample();
    f.advance(60); assert.equal((await f.sample()).creditedSeconds, 0);
    f.advance(60); await f.sample(); assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM duty_pap_awards")).rows[0]!.count, 0);
    f.advance(60); await f.sample();
    assert.equal((await f.pg.query<{ day: string }>("SELECT day FROM duty_pap_awards")).rows[0]!.day, "2026-10-05");
  } finally { await f.close(); }
});
test("pause/re-enable, rule edit and selected-character switch discard only unsettled time, preserving cap", async () => {
  const f = await createDutyPapFixture();
  try {
    let rule = await f.createRule({ minutesPerAward: 2 }); await f.authorize(); await f.sample(); f.advance(60); await f.sample();
    let connection = await f.connection(); await f.service.setConnectionEnabled(member, { version: connection.version, enabled: false });
    f.advance(60); assert.equal((await f.service.processObservation(connection.id, connection.version, f.observation())).ignored, true);
    connection = await f.connection(); await f.service.setConnectionEnabled(member, { version: connection.version, enabled: true });
    await f.sample(); f.advance(60); await f.sample();
    f.advance(60); await f.sample();
    assert.equal((await f.service.memberDashboard(member)).rules[0]!.today.paidAmount, "0.100000");
    connection = await f.connection(); await f.authorize(2, 11, connection.version); f.advance(60); await f.sample();
    rule = (await f.service.updateRule(admin, rule.id, { ...dutyRuleInput({ minutesPerAward: 1 }), enabled: true, version: rule.version })).rule!;
    assert.equal((await f.service.memberDashboard(member)).rules[0]!.today.eligibleSeconds, 0);
    f.advance(60); await f.sample(); f.advance(60); await f.sample();
    assert.equal((await f.service.memberDashboard(member)).rules[0]!.today.paidAmount, "0.200000");
  } finally { await f.close(); }
});
test("past cache from before reauthorization/rule change cannot count time before context change", async () => {
  const f = await createDutyPapFixture();
  try {
    const rule = await f.createRule(); await f.authorize(); await f.sample(); const earlier = f.now(); f.advance(60);
    await f.service.updateRule(admin, rule.id, { ...dutyRuleInput(), enabled: true, version: rule.version });
    assert.equal((await f.sample({ evidenceAt: earlier })).creditedSeconds, 0);
    f.advance(60); assert.equal((await f.sample()).creditedSeconds, 0);
    f.advance(60); assert.equal((await f.sample()).awardedAmount, "0.100000");
  } finally { await f.close(); }
});
test("runtime character/member/corp/module checks stop awards even after selection, historical corp never sampled", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule(); await f.authorize(); await f.sample();
    await f.pg.exec("UPDATE characters SET corporation_id=2002 WHERE id=10"); f.advance(60); assert.equal((await f.sample()).status, "member_unavailable");
    await f.pg.exec("UPDATE characters SET corporation_id=1001,deleted_at=now() WHERE id=10"); f.advance(60); assert.equal((await f.sample()).status, "member_unavailable");
    await f.pg.exec("UPDATE characters SET deleted_at=NULL WHERE id=10; DELETE FROM corporation_memberships WHERE user_id=2"); f.advance(60); assert.equal((await f.sample()).status, "member_unavailable");
    await f.pg.exec("INSERT INTO corporation_memberships(corporation_id,user_id) VALUES(1001,2); UPDATE corporations SET pap_enabled=false WHERE id=1001"); f.advance(60); assert.equal((await f.sample()).status, "module_disabled");
    assert.equal((await f.service.listCollectableConnections()).length, 0);
    await f.pg.exec("UPDATE corporations SET pap_enabled=true WHERE id=1001");
    await f.service.authorizeConnection(foreign, { characterId: 20, accessToken: "f", refreshToken: "r", tokenExpiry: new Date(+f.now() + 60_000), scopes: [...DUTY_PAP_SCOPES], expectedVersion: null });
    await f.createRule({}, foreign);
    assert.deepEqual((await f.service.listCollectableConnections()).map(row => row.corporationId), [1001]);
  } finally { await f.close(); }
});
test("configured non-primary site is allowed, ambiguous primaries and historical site rows fail closed", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule(); await f.authorize(); await f.sample();
    await f.pg.exec("UPDATE corporations SET is_primary=false WHERE id=1001");
    const selected = createDutyPapService({ database: f.database, now: f.now, configuredCorporationId: "1001" });
    assert.equal((await selected.listCollectableConnections()).length, 1);
    f.advance(60); const connection = await f.connection();
    assert.equal((await selected.processObservation(connection.id, connection.version, f.observation())).awardedAmount, "0.100000");
    await f.pg.exec("UPDATE corporations SET is_primary=true");
    assert.equal((await f.service.listCollectableConnections()).length, 0);
    f.advance(60); assert.equal((await f.sample()).status, "module_disabled");
    const invalid = createDutyPapService({ database: f.database, now: f.now, configuredCorporationId: "invalid" });
    assert.equal((await invalid.listCollectableConnections()).length, 0);
  } finally { await f.close(); }
});
test("already paid rules cannot change PAP currency, preserving comparable day caps", async () => {
  const f = await createDutyPapFixture();
  try {
    const { currency } = await f.createService().createCurrency(admin, { name: "新的种类", description: "", rate: "1", issuanceEnabled: true, conversionEnabled: true, requestId: randomUUID() });
    const rule = await f.createRule(); await f.authorize(); await f.sample(); f.advance(60); await f.sample();
    await assert.rejects(f.service.updateRule(admin, rule.id, { ...dutyRuleInput(), enabled: true, currencyId: currency!.id, version: rule.version }), { code: "DUTY_PAP_CURRENCY_LOCKED" });
    assert.equal((await f.service.memberDashboard(member)).rules[0]!.currencyId, null);
    assert.equal((await f.service.memberDashboard(member)).rules[0]!.today.paidAmount, "0.100000");
  } finally { await f.close(); }
});
test("paused PAP issuance never prevents disabling/editing a rule, but does prevent enabling it", async () => {
  const f = await createDutyPapFixture();
  try {
    const { currency } = await f.createService().createCurrency(admin, { name: "可停发的种类", description: "", rate: "1", issuanceEnabled: true, conversionEnabled: true, requestId: randomUUID() });
    const rule = await f.createRule({ currencyId: currency!.id });
    await f.pg.exec("UPDATE pap_currencies SET issuance_enabled=false");
    const body = dutyRuleInput({ currencyId: currency!.id, enabled: false, version: rule.version });
    const disabled = (await f.service.updateRule(admin, rule.id, body)).rule!;
    assert.equal(disabled.enabled, false);
    const edited = (await f.service.updateRule(admin, rule.id, { ...body, name: "停发后仍可编辑", version: disabled.version })).rule!;
    assert.equal(edited.name, "停发后仍可编辑");
    await assert.rejects(f.service.updateRule(admin, rule.id, { ...body, enabled: true, version: edited.version }), { code: "DUTY_PAP_CURRENCY_PAUSED" });
    assert.equal((await f.service.createRule(admin, dutyRuleInput({ currencyId: currency!.id }))).rule!.enabled, false);
  } finally { await f.close(); }
});
test("member/admin dashboards expose no tokens, live position or other corporation's records", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule(); await f.authorize(); await f.sample(); f.advance(60); await f.sample();
    const memberView = await f.service.memberDashboard(member), adminView = await f.service.adminDashboard(admin), otherView = await f.service.memberDashboard(other), foreignView = await f.service.adminDashboard(foreign);
    const text = JSON.stringify([memberView, adminView]);
    for (const value of ["duty-access-only", "duty-refresh-only", "existing-skill-access", "lastSolarSystemId", "lastShipTypeId", "lastFleetId"]) assert.equal(text.includes(value), false);
    assert.equal(memberView.characters[0]!.name, "值守角色一");
    assert.equal(adminView.awards.length, 1); assert.equal(otherView.awards.length, 0); assert.equal(foreignView.rules.length, 0); assert.equal(foreignView.awards.length, 0);
    await assert.rejects(f.service.adminDashboard(member), { code: "DUTY_PAP_ADMIN_REQUIRED" });
  } finally { await f.close(); }
});
test("grant constraint or ledger failure rolls back progress, common balance and history together", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule(); await f.authorize(); await f.sample();
    await f.pg.exec("ALTER TABLE duty_pap_awards ADD CONSTRAINT test_reject CHECK(amount<0)"); f.advance(60);
    await assert.rejects(f.sample());
    assert.equal((await f.pg.query<{ amount: number }>("SELECT redeemable_pap AS amount FROM users WHERE id=2")).rows[0]!.amount, 12.5);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM pap_records")).rows[0]!.count, 0);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM pap_ledger")).rows[0]!.count, 0);
    assert.equal((await f.service.memberDashboard(member)).rules[0]!.today.paidAmount, "0.000000");
  } finally { await f.close(); }
});
test("account merge preserves combined daily caps and immutable audit names, pauses destination and deletes source credentials", async () => {
  const f = await createDutyPapFixture();
  try {
    await f.createRule(); await f.authorize(); await f.authorize(3, 12);
    await f.sample({}, 2); await f.sample({}, 3); f.advance(60); await f.sample({}, 2); await f.sample({}, 3);
    await f.database.transaction(async tx => { await mergeDutyPapAccounts(tx, 1001, 2, 3, f.now()); });
    const view = await f.service.memberDashboard(other);
    assert.equal(view.connection!.enabled, false); assert.equal(view.rules[0]!.today.paidAmount, "0.200000");
    assert.deepEqual(view.awards.map(award => award.awardIndex).sort(), [1, 2]);
    assert.equal(view.awards.some(award => award.userName === "测试成员"), true);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM duty_pap_connections WHERE user_id=2")).rows[0]!.count, 0);
    assert.equal((await f.pg.query<{ count: number }>("SELECT count(*) AS count FROM duty_pap_progress WHERE user_id=2")).rows[0]!.count, 0);
    await f.service.setConnectionEnabled(other, { version: view.connection!.version, enabled: true });
    f.advance(60); await f.sample({}, 3); f.advance(60); await f.sample({}, 3);
    assert.equal((await f.service.memberDashboard(other)).rules[0]!.today.paidAmount, "0.250000");
  } finally { await f.close(); }
});
