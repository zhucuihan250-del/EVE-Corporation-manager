import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { usersTable } from "@workspace/db/schema";
import { createPapCurrencyFixture, PAP_FIXTURE_ACTORS } from "./pap-currency-test-fixture";
import { mergePapWallets } from "./pap-currency-account-merge";

test("account linking preserves all custom assets, carry, frozen common PAP and immutable history", async () => {
  const fixture = await createPapCurrencyFixture();
  try {
    const { currency } = await fixture.service.createCurrency(PAP_FIXTURE_ACTORS[1], {
      name: "测试合并资产", description: "仅测试", rate: "0.333333", issuanceEnabled: true, conversionEnabled: true, requestId: randomUUID(),
    });
    for (const userId of [2, 3]) {
      await fixture.service.adjust(PAP_FIXTURE_ACTORS[1], { currencyId: currency.id, userId, amount: "2.5", reason: "测试资产", version: 0, requestId: randomUUID() });
      const preview = await fixture.service.preview(PAP_FIXTURE_ACTORS[userId], { currencyId: currency.id, amount: "0.000005" });
      await fixture.service.convert(PAP_FIXTURE_ACTORS[userId], { ...preview, requestId: randomUUID() });
    }
    await fixture.service.editCurrency(PAP_FIXTURE_ACTORS[1], currency.id, {
      name: "改名后暂停", description: "暂停也必须保留并转移资产", rate: "2", issuanceEnabled: false, conversionEnabled: false, version: 0,
    });
    await fixture.database.transaction(async tx => {
      assert.ok(await mergePapWallets(tx, 1001, 3, 2));
      await tx.delete(usersTable).where(eq(usersTable.id, 3));
    });
    const result = await fixture.service.getWallet(PAP_FIXTURE_ACTORS[2]);
    assert.deepEqual(result.common, { balance: "12.500003", locked: "2.000000", available: "10.500003" });
    assert.equal(result.wallets.length, 1);
    assert.equal(result.wallets[0].balance, "4.999990");
    assert.equal(result.wallets[0].carry, "0.000000333330");
    const audit = await fixture.service.listEntries(PAP_FIXTURE_ACTORS[1], true);
    assert.equal(audit.length, 6);
    assert.equal(audit.filter(entry => entry.userId === null).length, 3);
    assert.equal(audit.filter(entry => entry.type === "conversion").every(entry => entry.currencyName === "测试合并资产" && entry.rate === "0.333333"), true);
    assert.equal(audit.filter(entry => entry.type === "account_merge" && entry.userId === 2)[0].commonAmount, "0.000001");
    assert.equal(await fixture.database.transaction(tx => mergePapWallets(tx, 1001, 3, 2)), null);
    assert.deepEqual((await fixture.service.getWallet(PAP_FIXTURE_ACTORS[2])).common, result.common);
  } finally { await fixture.close(); }
});

test("account linking rolls back atomically on aggregate limit and rejects external/self targets", async () => {
  const fixture = await createPapCurrencyFixture();
  try {
    const { currency } = await fixture.service.createCurrency(PAP_FIXTURE_ACTORS[1], {
      name: "边界测试", rate: "1", issuanceEnabled: true, conversionEnabled: true, requestId: randomUUID(),
    });
    for (const userId of [2, 3]) await fixture.service.adjust(PAP_FIXTURE_ACTORS[1], {
      currencyId: currency.id, userId, amount: "600000000", reason: "余额边界", version: 0, requestId: randomUUID(),
    });
    const before = await fixture.service.getWallet(PAP_FIXTURE_ACTORS[2]);
    await assert.rejects(fixture.database.transaction(tx => mergePapWallets(tx, 1001, 3, 2)), /上限/);
    assert.deepEqual(await fixture.service.getWallet(PAP_FIXTURE_ACTORS[2]), before);
    await assert.rejects(fixture.database.transaction(tx => mergePapWallets(tx, 1001, 4, 2)), /same site corporation/);
    await assert.rejects(fixture.database.transaction(tx => mergePapWallets(tx, 1001, 2, 2)), /itself/);
    assert.deepEqual(await fixture.service.getWallet(PAP_FIXTURE_ACTORS[2]), before);
  } finally { await fixture.close(); }
});
