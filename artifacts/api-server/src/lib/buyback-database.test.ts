import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { DEFAULT_BUYBACK_SETTINGS } from "./buyback-calculation";
import { BUYBACK_FIXTURE_ACTORS as actors, createBuybackFixture } from "./buyback-test-fixture";

const administrator = actors[1]!;
const member = actors[2]!;
const otherMember = actors[3]!;
const otherCorporation = actors[4]!;
const openSettings = { ...DEFAULT_BUYBACK_SETTINGS, enabled: true };
const typeRule = { scope: "type", targetId: 34, enabled: false, priceBasis: null, fixedPrice: null, ratePercent: null };

test("HTTP quote parser permits Chinese clipboard columns within the character limit", async () => {
  const fixture = await createBuybackFixture();
  const { url, server } = await fixture.listen();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    const response = await fetch(`${url}/api/buyback/quotes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: `Tritanium\t1\t${"备注".repeat(40000)}` }),
    });
    assert.equal(response.status, 201);
    assert.equal((await response.json() as { totalIsk: string }).totalIsk, "10.00");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});

test("additive migration reruns safely and keeps existing records", async () => {
  const fixture = await createBuybackFixture();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    const quote = await fixture.service.createQuote(member, { text: "Tritanium\t100" });
    await fixture.runMigration();
    const settings = await fixture.service.getConfiguration(1001);
    assert.equal(settings.settings.version, 1);
    assert.equal((await fixture.service.listQuotes(member))[0]!.id, quote.id);
    assert.deepEqual((await fixture.pg.query("SELECT id FROM corporations ORDER BY id")).rows, [{ id: 1001 }, { id: 2002 }]);
  } finally { await fixture.close(); }
});

test("schema constraints reject invalid pricing and protect immutable snapshots", async () => {
  const fixture = await createBuybackFixture();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    const quote = await fixture.service.createQuote(member, { text: "Tritanium\t1" });
    await assert.rejects(fixture.pg.query("UPDATE buyback_settings SET rate_percent = 0 WHERE corporation_id = 1001"));
    await assert.rejects(fixture.pg.query("UPDATE buyback_settings SET price_basis = 'fixed', fixed_price = NULL WHERE corporation_id = 1001"));
    await assert.rejects(fixture.pg.query("UPDATE buyback_quotes SET total_isk = 1 WHERE id = $1", [quote.id]));
    await assert.rejects(fixture.pg.query("UPDATE buyback_quotes SET expires_at = expires_at + interval '1 hour' WHERE id = $1", [quote.id]));
    await assert.rejects(fixture.pg.query("UPDATE buyback_quotes SET submitted_by = 3 WHERE id = $1", [quote.id]));
    await fixture.pg.query("DELETE FROM users WHERE id = 2");
    const saved = await fixture.pg.query<{ submitted_by: number | null; total_isk: string; submitter_name: string }>("SELECT submitted_by, total_isk, submitter_name FROM buyback_quotes WHERE id = $1", [quote.id]);
    assert.deepEqual(saved.rows[0], { submitted_by: null, total_isk: "10.00", submitter_name: "测试成员" });
  } finally { await fixture.close(); }
});

test("configuration versions serialize concurrent administrator edits and require versions on rules", async () => {
  const fixture = await createBuybackFixture();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    const edits = await Promise.allSettled([
      fixture.service.saveSettings(administrator, { ...openSettings, version: 1, ratePercent: 90 }),
      fixture.service.saveSettings(administrator, { ...openSettings, version: 1, ratePercent: 80 }),
    ]);
    assert.equal(edits.filter(result => result.status === "fulfilled").length, 1);
    const rejected = edits.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "BUYBACK_VERSION_CONFLICT");
    await assert.rejects(fixture.service.writeRule(administrator, typeRule), { code: "INVALID_BUYBACK_VERSION" });
    const current = await fixture.service.getConfiguration(1001);
    const written = await fixture.service.writeRule(administrator, { ...typeRule, version: current.settings.version });
    const id = written.rules[0]!.id!;
    await assert.rejects(fixture.service.deleteRule(administrator, id, undefined), { code: "INVALID_BUYBACK_VERSION" });
    await assert.rejects(fixture.service.deleteRule(administrator, id, 1), { code: "BUYBACK_VERSION_CONFLICT" });
    assert.equal((await fixture.service.getConfiguration(1001)).rules.length, 1);
    const deleted = await fixture.service.deleteRule(administrator, id, written.settings.version);
    assert.equal(deleted.rules.length, 0);
    assert.equal(deleted.settings.version, written.settings.version + 1);
  } finally { await fixture.close(); }
});

test("rules edited during market fetch reject stale quotes without saving partial data", async () => {
  let started!: () => void;
  let release!: () => void;
  const marketStarted = new Promise<void>(resolve => { started = resolve; });
  const marketReleased = new Promise<void>(resolve => { release = resolve; });
  const fixture = await createBuybackFixture({ getPrices: async ids => {
    started(); await marketReleased;
    return new Map(ids.map(id => [id, { buy: "10", sell: "12", updatedAt: new Date().toISOString() }]));
  } });
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    const quotation = fixture.service.createQuote(member, { text: "Tritanium\t100" });
    await marketStarted;
    await fixture.service.saveSettings(administrator, { ...openSettings, version: 1, ratePercent: 50 });
    const rejection = assert.rejects(quotation, { code: "BUYBACK_VERSION_CONFLICT" });
    release(); await rejection;
    assert.equal((await fixture.service.listQuotes(member)).length, 0);
  } finally { release(); await fixture.close(); }
});

test("saved quotes and expiration survive later configuration edits and retries are idempotent", async () => {
  const fixture = await createBuybackFixture();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    const requestId = randomUUID();
    const quote = await fixture.service.createQuote(member, { text: "Tritanium\t100", requestId });
    await fixture.service.saveSettings(administrator, { ...openSettings, version: 1, ratePercent: 50, quoteValidityMinutes: 1 });
    const repeated = await fixture.service.createQuote(member, { text: "Tritanium\t100", requestId });
    assert.deepEqual(repeated, quote);
    assert.equal(quote.totalIsk, "1000.00");
    assert.equal(new Date(quote.expiresAt).getTime() - new Date(quote.createdAt).getTime(), 30 * 60_000);
    const fresh = await fixture.service.createQuote(member, { text: "Tritanium\t100" });
    assert.equal(fresh.totalIsk, "500.00");
    assert.equal(fresh.settingsVersion, 2);
    assert.equal(new Date(fresh.expiresAt).getTime() - new Date(fresh.createdAt).getTime(), 60_000);
    await assert.rejects(fixture.service.createQuote(member, { text: "Tritanium\t200", requestId }), { code: "BUYBACK_REQUEST_CONFLICT" });
    assert.equal((await fixture.service.listQuotes(member)).length, 2);
  } finally { await fixture.close(); }
});

test("concurrent retries through independent workers save only one immutable quote", async () => {
  const fixture = await createBuybackFixture();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    const secondWorker = fixture.createService();
    const request = { text: "Tritanium\t100", requestId: randomUUID() };
    const [first, second] = await Promise.all([
      fixture.service.createQuote(member, request), secondWorker.createQuote(member, request),
    ]);
    assert.deepEqual(first, second);
    assert.equal((await fixture.service.listQuotes(member)).length, 1);
    const stored = await fixture.pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM buyback_quotes");
    assert.equal(stored.rows[0]!.count, 1);
  } finally { await fixture.close(); }
});

test("history result sizes and hourly quote storage remain bounded across workers", async () => {
  const fixture = await createBuybackFixture();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    await fixture.pg.exec(`
      INSERT INTO buyback_quotes (
        corporation_id, submitted_by, submitter_name, input_text, request_id,
        total_isk, complete, settings_version, settings_snapshot, rules_snapshot,
        lines, created_at, expires_at
      ) SELECT 1001, 2, 'Fixture', 'Tritanium',
        '00000000-0000-0000-0000-' || lpad(n::text, 12, '0'), 10, true, 1,
        '{}'::jsonb, '[]'::jsonb, '[{}]'::jsonb,
        now(), now() + interval '30 minutes'
        FROM generate_series(1, 110) AS n;
    `);
    assert.equal((await fixture.service.listQuotes(member)).length, 50);
    assert.equal((await fixture.service.listQuotes(administrator, true)).length, 100);
    await assert.rejects(fixture.createService().createQuote(member, { text: "Tritanium" }), { code: "BUYBACK_HOURLY_LIMIT" });
    const saved = await fixture.pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM buyback_quotes");
    assert.equal(saved.rows[0]!.count, 110);
  } finally { await fixture.close(); }
});

test("members see only their quotes, administrators only current corporation, FC cannot manage", async () => {
  const fixture = await createBuybackFixture();
  try {
    await fixture.service.saveSettings(administrator, openSettings);
    await fixture.service.saveSettings(otherCorporation, openSettings);
    const requestId = randomUUID();
    const first = await fixture.service.createQuote(member, { text: "Tritanium", requestId });
    const second = await fixture.service.createQuote(otherMember, { text: "Pyerite", requestId });
    const foreign = await fixture.service.createQuote(otherCorporation, { text: "Tritanium", requestId });
    assert.deepEqual((await fixture.service.listQuotes(member)).map(quote => quote.id), [first.id]);
    assert.deepEqual((await fixture.service.listQuotes(otherMember)).map(quote => quote.id), [second.id]);
    assert.deepEqual((await fixture.service.listQuotes(administrator, true)).map(quote => quote.id).sort(), [first.id, second.id].sort());
    assert.deepEqual((await fixture.service.listQuotes(otherCorporation, true)).map(quote => quote.id), [foreign.id]);
    await assert.rejects(fixture.service.listQuotes(member, true), { code: "BUYBACK_ADMIN_REQUIRED" });
    await assert.rejects(fixture.service.saveSettings(actors[5]!, { ...openSettings, version: 1 }), { code: "BUYBACK_ADMIN_REQUIRED" });
    const written = await fixture.service.writeRule(otherCorporation, { ...typeRule, version: 1 });
    await assert.rejects(fixture.service.deleteRule(administrator, written.rules[0]!.id!, 1), { code: "BUYBACK_RULE_NOT_FOUND" });
    assert.equal((await fixture.service.getConfiguration(2002)).rules.length, 1);
  } finally { await fixture.close(); }
});

test("disabled, excluded, missing-price, blueprint and unrecognized lines do not become full quotes", async () => {
  const requestedIds: number[][] = [];
  const fixture = await createBuybackFixture({ getPrices: async ids => { requestedIds.push(ids); return new Map(); } });
  try {
    await assert.rejects(fixture.service.createQuote(member, { text: "Tritanium" }), { code: "BUYBACK_CLOSED" });
    await fixture.service.saveSettings(administrator, openSettings);
    await fixture.service.writeRule(administrator, { ...typeRule, version: 1 });
    const result = await fixture.service.createQuote(member, { text: "Tritanium\nPyerite\nDamage Control II Blueprint\nUnknown item" });
    assert.equal(result.complete, false);
    assert.equal(result.totalIsk, "0.00");
    assert.deepEqual((result.lines as Array<{ status: string }>).map(line => line.status), ["excluded", "unpriced", "invalid", "unrecognized"]);
    assert.deepEqual(requestedIds, [[35]]);
    await assert.rejects(fixture.service.createQuote(member, { text: Array.from({ length: 81 }, (_, i) => `Unknown ${i}`).join("\n") }), { code: "BUYBACK_TYPE_LIMIT" });
  } finally { await fixture.close(); }
});

test("real HTTP router enforces auth/admin boundaries, errors and request scoping", async () => {
  const fixture = await createBuybackFixture();
  const { url, server } = await fixture.listen();
  try {
    const request = (path: string, user: number, method = "GET", body?: unknown) => fetch(`${url}/api${path}`, {
      method, headers: { "x-test-user": String(user), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal((await request("/buyback/settings", 0)).status, 401);
    assert.equal((await request("/admin/buyback", 2)).status, 403);
    assert.equal((await request("/admin/buyback/settings", 5, "PUT", openSettings)).status, 403);
    assert.equal((await request("/admin/buyback/settings", 1, "PUT", openSettings)).status, 200);
    const response = await request("/buyback/quotes", 2, "POST", { text: "Tritanium\t100", corporationId: 2002, submittedBy: 4 });
    assert.equal(response.status, 201);
    const quote = await response.json() as { submitterName: string };
    assert.equal(quote.submitterName, member.userName);
    const hidden = await request("/buyback/quotes", 3);
    assert.deepEqual(await hidden.json(), { quotes: [] });
    assert.equal((await request("/admin/buyback/rules", 1, "POST", { ...typeRule, version: 1 })).status, 201);
    assert.equal((await request("/admin/buyback/rules", 1, "POST", { ...typeRule, version: 2 })).status, 409);
    assert.equal((await request("/admin/buyback/rules/1e0", 1, "DELETE", { version: 2 })).status, 400);
    assert.equal((await request("/buyback/catalog?kind=invalid", 1)).status, 400);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await fixture.close();
  }
});
