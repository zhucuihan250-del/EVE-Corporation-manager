import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createPapCurrencyFixture, PAP_FIXTURE_ACTORS as ACTORS } from "./pap-currency-test-fixture";
import { awardCustomPap } from "./pap-currency-service";
import { PapCurrencyError } from "./pap-currency-math";

const input = (name = "测试自定义 PAP", rate = "1.25") => ({ name, description: "测试自建，无系统预设", rate, issuanceEnabled: true, conversionEnabled: true, requestId: randomUUID() });
const fail = (code: string) => (error: unknown) => error instanceof PapCurrencyError && error.code === code;
async function seeded() {
  const f = await createPapCurrencyFixture();
  const { currency } = await f.service.createCurrency(ACTORS[1], input());
  await f.service.adjust(ACTORS[1], { currencyId: currency.id, userId: 2, amount: "10", reason: "测试发放", version: 0, requestId: randomUUID() });
  return { ...f, currency };
}
test("additive migration is repeatable, preserves legacy balances, and seeds zero currencies", async () => {
  const f = await createPapCurrencyFixture();
  try {
    await f.runMigration();
    assert.deepEqual(await f.service.listCurrencies(1001), []);
    assert.deepEqual((await f.pg.query("SELECT total_pap,redeemable_pap,locked_pap FROM users WHERE id=2")).rows, [{ total_pap: 12.5, redeemable_pap: 12.5, locked_pap: 2 }]);
    assert.equal((await f.service.getWallet(ACTORS[2])).common.available, "10.500000");
  } finally { await f.close(); }
});
test("admin-only editable names/rates and case-normalized names cannot impersonate common PAP", async () => {
  const f = await createPapCurrencyFixture();
  try {
    for (const id of [2, 5]) await assert.rejects(f.service.createCurrency(ACTORS[id], input()), fail("PAP_ADMIN_REQUIRED"));
    await assert.rejects(f.service.createCurrency(ACTORS[1], input("通用 PAP")), fail("PAP_INVALID_CURRENCY_NAME"));
    const original = input("Alpha"), { currency } = await f.service.createCurrency(ACTORS[1], original);
    assert.equal((await f.service.createCurrency(ACTORS[1], original)).replayed, true);
    await assert.rejects(f.service.createCurrency(ACTORS[1], input("Ａｌｐｈａ")), fail("PAP_CURRENCY_NAME_EXISTS"));
    const updated = await f.service.editCurrency(ACTORS[1], currency.id, { ...original, name: "Beta", rate: "0.5", version: 0 });
    assert.equal(updated.currency.rate, "0.500000"); assert.equal(updated.currency.version, 1);
    await assert.rejects(f.service.editCurrency(ACTORS[1], currency.id, { ...original, version: 0 }), fail("PAP_VERSION_CONFLICT"));
  } finally { await f.close(); }
});
test("conversion is atomic, idempotent, uses server rate and preserves common locks", async () => {
  const f = await seeded();
  try {
    const preview = await f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "0.5" });
    assert.equal(preview.commonAmount, "0.625000");
    const request = { currencyId: f.currency.id, amount: "0.5", version: preview.version, walletVersion: preview.walletVersion, requestId: randomUUID(), commonAmount: "999999999" };
    const first = await f.service.convert(ACTORS[2], request);
    const retry = await f.createService().convert(ACTORS[2], request);
    assert.equal(first.entry.id, retry.entry.id); assert.equal(retry.replayed, true);
    const wallet = await f.service.getWallet(ACTORS[2]);
    assert.equal(wallet.common.balance, "13.125000"); assert.equal(wallet.common.locked, "2.000000"); assert.equal(wallet.wallets[0].balance, "9.500000");
    assert.equal((await f.pg.query<{ n: number }>("SELECT COUNT(*)::integer n FROM pap_ledger WHERE type='pap_conversion'")).rows[0].n, 1);
    await assert.rejects(f.service.convert(ACTORS[2], { ...request, amount: "1" }), fail("PAP_REQUEST_CONFLICT"));
    await assert.rejects(f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "1", targetCurrencyId: 999 }), fail("PAP_ONE_WAY_ONLY"));
  } finally { await f.close(); }
});
test("competing conversions with one preview commit at most once", async () => {
  const f = await seeded();
  try {
    const preview = await f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "2" });
    const request = { currencyId: f.currency.id, amount: "2", version: preview.version, walletVersion: preview.walletVersion };
    const results = await Promise.allSettled([f.service.convert(ACTORS[2], { ...request, requestId: randomUUID() }), f.createService().convert(ACTORS[2], { ...request, requestId: randomUUID() })]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await f.service.getWallet(ACTORS[2])).wallets[0].balance, "8.000000");
  } finally { await f.close(); }
});
test("concurrent identical requests and retry after pause return one immutable result", async () => {
  const f = await seeded();
  try {
    const preview = await f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "1" });
    const request = { currencyId: f.currency.id, amount: "1", version: preview.version, walletVersion: preview.walletVersion, requestId: randomUUID() };
    const responses = await Promise.all([f.service.convert(ACTORS[2], request), f.createService().convert(ACTORS[2], request)]);
    assert.equal(responses[0].entry.id, responses[1].entry.id);
    assert.equal(responses.filter(response => response.replayed).length, 1);
    await f.service.editCurrency(ACTORS[1], f.currency.id, { ...input(), conversionEnabled: false, version: 0 });
    assert.equal((await f.service.convert(ACTORS[2], request)).entry.id, responses[0].entry.id);
    assert.equal((await f.service.getWallet(ACTORS[2])).wallets[0].balance, "9.000000");
  } finally { await f.close(); }
});
test("downstream ledger failures roll back every balance and snapshot, and common upper bounds fail closed", async () => {
  const f = await seeded();
  try {
    const before = await f.service.getWallet(ACTORS[2]);
    const preview = await f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "1" });
    await f.pg.exec(`CREATE FUNCTION fail_common_ledger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test write failure'; END; $$; CREATE TRIGGER fail_common_ledger BEFORE INSERT ON pap_ledger FOR EACH ROW EXECUTE FUNCTION fail_common_ledger();`);
    await assert.rejects(f.service.convert(ACTORS[2], { currencyId: f.currency.id, amount: "1", version: preview.version, walletVersion: preview.walletVersion, requestId: randomUUID() }));
    assert.deepEqual(await f.service.getWallet(ACTORS[2]), before);
    await f.pg.exec("DROP TRIGGER fail_common_ledger ON pap_ledger; UPDATE users SET redeemable_pap=1000000000,total_pap=1000000000 WHERE id=2");
    await assert.rejects(f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "0.000001" }), fail("PAP_COMMON_BALANCE_LIMIT"));
    assert.equal((await f.service.getWallet(ACTORS[2])).wallets[0].balance, "10.000000");
  } finally { await f.close(); }
});
test("insufficient, too-small, paused and changed-rate conversions never debit", async () => {
  const f = await seeded();
  try {
    await assert.rejects(f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "11" }), fail("PAP_INSUFFICIENT_BALANCE"));
    const old = await f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "1" });
    await f.service.editCurrency(ACTORS[1], f.currency.id, { ...input(), rate: "0.000001", version: 0 });
    await assert.rejects(f.service.convert(ACTORS[2], { currencyId: f.currency.id, amount: "1", version: old.version, walletVersion: old.walletVersion, requestId: randomUUID() }), fail("PAP_VERSION_CONFLICT"));
    await assert.rejects(f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "0.1" }), fail("PAP_CONVERSION_TOO_SMALL"));
    await f.service.editCurrency(ACTORS[1], f.currency.id, { ...input(), conversionEnabled: false, version: 1 });
    await assert.rejects(f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "1" }), fail("PAP_CONVERSION_PAUSED"));
    assert.equal((await f.service.getWallet(ACTORS[2])).wallets[0].balance, "10.000000");
  } finally { await f.close(); }
});
test("carry survives conversion, rate edits and history snapshots remain immutable", async () => {
  const f = await seeded();
  try {
    await f.service.editCurrency(ACTORS[1], f.currency.id, { ...input("旧名称", "0.333333"), version: 0 });
    const p = await f.service.preview(ACTORS[2], { currencyId: f.currency.id, amount: "0.00001" });
    const result = await f.service.convert(ACTORS[2], { currencyId: f.currency.id, amount: "0.00001", version: p.version, walletVersion: p.walletVersion, requestId: randomUUID() });
    assert.equal(result.entry.commonAmount, "0.000003"); assert.equal(result.entry.carryAfter, "0.000000333330");
    await f.service.editCurrency(ACTORS[1], f.currency.id, { ...input("新名称", "2"), version: 1 });
    const history = await f.service.listEntries(ACTORS[2]);
    assert.equal(history[0].currencyName, "旧名称"); assert.equal(history[0].rate, "0.333333");
    assert.equal((await f.service.getWallet(ACTORS[2])).wallets[0].carry, "0.000000333330");
    await assert.rejects(f.pg.exec(`UPDATE pap_currency_ledger SET amount=999 WHERE id=${result.entry.id}`));
  } finally { await f.close(); }
});
test("manual adjustments and fleet awards preserve common PAP and enforce issuance/ownership", async () => {
  const f = await seeded();
  try {
    const request = { currencyId: f.currency.id, userId: 2, amount: "-1.25", reason: "纠正发放", version: 0, requestId: randomUUID() };
    await f.service.adjust(ACTORS[1], request); assert.equal((await f.service.adjust(ACTORS[1], request)).replayed, true);
    await assert.rejects(f.service.adjust(ACTORS[1], { ...request, amount: "-10", requestId: randomUUID() }), fail("PAP_INSUFFICIENT_BALANCE"));
    await f.database.transaction(tx => awardCustomPap(tx, { corporationId: 1001, userId: 2, userName: "测试成员", currencyId: f.currency.id, amount: "0.5", reason: "舰队测试", fleetId: 99, characterId: 200 }));
    assert.equal((await f.service.getWallet(ACTORS[2])).common.balance, "12.500000");
    assert.equal((await f.service.getWallet(ACTORS[2])).wallets[0].balance, "9.250000");
    await f.service.editCurrency(ACTORS[1], f.currency.id, { ...input(), issuanceEnabled: false, version: 0 });
    await assert.rejects(f.service.adjust(ACTORS[1], { ...request, version: 1, amount: "1", requestId: randomUUID() }), fail("PAP_ISSUANCE_PAUSED"));
    await assert.rejects(f.database.transaction(tx => awardCustomPap(tx, { corporationId: 1001, userId: 2, userName: "测试成员", currencyId: f.currency.id, amount: "1", reason: "test" })), fail("PAP_ISSUANCE_PAUSED"));
    await f.service.adjust(ACTORS[1], { ...request, version: 1, amount: "-0.25", requestId: randomUUID() });
    assert.equal((await f.service.getWallet(ACTORS[2])).wallets[0].balance, "9.000000");
    await assert.rejects(f.service.adjust(ACTORS[1], { ...request, userId: 4, version: 1, requestId: randomUUID() }), fail("PAP_MEMBER_NOT_FOUND"));
  } finally { await f.close(); }
});
test("HTTP auth, admin boundaries, member privacy, foreign corporation and no delete endpoint", async () => {
  const f = await seeded(), { server, url } = await f.listen();
  const request = (path: string, user: number, method = "GET", body?: unknown) => fetch(`${url}/api${path}`, { method, headers: { "x-test-user": String(user), "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  try {
    assert.equal((await request("/pap-wallet", 0)).status, 401);
    for (const user of [2, 5]) assert.equal((await request("/admin/pap-currencies", user)).status, 403);
    assert.equal((await request("/admin/pap-currencies", 1)).status, 200);
    assert.deepEqual(await (await request("/pap-currencies", 4)).json(), { currencies: [] });
    assert.equal((await request("/pap-wallet/preview", 4, "POST", { currencyId: f.currency.id, amount: "1" })).status, 404);
    const other = await (await request("/pap-wallet", 3)).json() as { wallets: unknown[]; entries: unknown[] }; assert.deepEqual(other.wallets, []); assert.deepEqual(other.entries, []);
    assert.equal((await request(`/admin/pap-currencies/${f.currency.id}`, 1, "DELETE")).status, 404);
    const members = await (await request("/admin/pap-currencies/members?query=", 1)).json() as { members: { id: number }[] }; assert.equal(members.members.some(row => row.id === 4), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
test("PAP module guard denies reads and mutations even for an administrator", async () => {
  const f = await createPapCurrencyFixture({ papEnabled: false }), { server, url } = await f.listen();
  try {
    for (const path of ["/pap-currencies", "/pap-wallet", "/admin/pap-currencies"]) {
      const response = await fetch(`${url}/api${path}`, { headers: { "x-test-user": "1" } });
      assert.equal(response.status, 404);
    }
    const response = await fetch(`${url}/api/admin/pap-currencies`, { method: "POST", headers: { "x-test-user": "1", "content-type": "application/json" }, body: JSON.stringify(input()) });
    assert.equal(response.status, 404); assert.deepEqual(await f.service.listCurrencies(1001), []);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});
