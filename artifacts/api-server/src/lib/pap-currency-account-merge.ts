import { and, asc, eq, inArray } from "drizzle-orm";
import type { db } from "@workspace/db";
import { papCurrenciesTable, papCurrencyWalletsTable, papCurrencyLedgerTable, papLedgerTable, usersTable } from "@workspace/db/schema";
import { commonPapUnits, formatPapUnits, MAX_PAP, PAP_SCALE, PapCurrencyError, parsePapDecimal } from "./pap-currency-math";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Run inside the account-merge transaction, before moving records/deleting the source.
 * Lock order matches conversions and grants: currencies, users, then wallets.
 * Immutable source history keeps its name snapshot after the source FK becomes null. */
export async function mergePapWallets(tx: Transaction, corporationId: number, sourceId: number, targetId: number) {
  if (sourceId === targetId) throw new Error("Cannot merge an account into itself");
  const currencies = await tx.select().from(papCurrenciesTable)
    .where(eq(papCurrenciesTable.corporationId, corporationId)).orderBy(asc(papCurrenciesTable.id)).for("update");
  const users = await tx.select().from(usersTable).where(inArray(usersTable.id, [sourceId, targetId]))
    .orderBy(asc(usersTable.id)).for("update");
  const source = users.find(user => user.id === sourceId);
  const target = users.find(user => user.id === targetId);
  if (!source) return null; // A concurrent linking request has already merged it.
  if (!target || source.corporationId !== corporationId || target.corporationId !== corporationId) {
    throw new Error("Accounts must belong to the same site corporation");
  }
  const wallets = await tx.select().from(papCurrencyWalletsTable)
    .where(inArray(papCurrencyWalletsTable.userId, [sourceId, targetId]))
    .orderBy(asc(papCurrencyWalletsTable.currencyId), asc(papCurrencyWalletsTable.userId)).for("update");
  if (wallets.some(wallet => wallet.corporationId !== corporationId)) {
    throw new Error("Historical external PAP wallets cannot be merged into this site");
  }
  let common = commonPapUnits(target.redeemablePap) + commonPapUnits(source.redeemablePap);
  const locked = commonPapUnits(target.lockedPap) + commonPapUnits(source.lockedPap);
  for (const wallet of wallets.filter(wallet => wallet.userId === sourceId)) {
    const currency = currencies.find(currency => currency.id === wallet.currencyId);
    if (!currency) throw new Error("Currency changed during account merge; retry linking");
    const destination = wallets.find(row => row.userId === targetId && row.currencyId === wallet.currencyId);
    if ((destination?.version ?? 0) >= 2_147_483_646) throw new PapCurrencyError(409, "PAP_VERSION_LIMIT", "余额版本达到上限，请联系管理员。");
    const amount = parsePapDecimal(wallet.balance);
    const before = parsePapDecimal(destination?.balance ?? "0");
    const after = before + amount;
    const carryBefore = parsePapDecimal(destination?.carry ?? "0", 12);
    const carry = carryBefore + parsePapDecimal(wallet.carry, 12);
    const credit = carry / PAP_SCALE;
    const remainder = carry % PAP_SCALE;
    if (after > MAX_PAP || common + credit > MAX_PAP) throw new PapCurrencyError(409, "PAP_AMOUNT_LIMIT", "合并后的 PAP 余额超过上限，请联系管理员。");
    await tx.insert(papCurrencyWalletsTable).values({
      corporationId, currencyId: currency.id, userId: targetId,
      balance: formatPapUnits(after), carry: formatPapUnits(remainder, 12), version: (destination?.version ?? 0) + 1,
    }).onConflictDoUpdate({ target: [papCurrencyWalletsTable.corporationId, papCurrencyWalletsTable.currencyId, papCurrencyWalletsTable.userId], set: {
      balance: formatPapUnits(after), carry: formatPapUnits(remainder, 12), version: (destination?.version ?? 0) + 1, updatedAt: new Date(),
    } });
    const snapshot = { corporationId, currencyId: currency.id, currencyName: currency.name, currencyVersion: currency.version, type: "account_merge" as const,
      reason: `关联角色：账号 ${sourceId} 合并至 ${targetId}` };
    await tx.insert(papCurrencyLedgerTable).values([
      { ...snapshot, userId: sourceId, userName: source.eveCharacterName ?? `#${sourceId}`, amount: formatPapUnits(-amount),
        balanceBefore: wallet.balance, balanceAfter: "0", carryBefore: wallet.carry, carryAfter: "0" },
      { ...snapshot, userId: targetId, userName: target.eveCharacterName ?? `#${targetId}`, amount: formatPapUnits(amount),
        balanceBefore: formatPapUnits(before), balanceAfter: formatPapUnits(after), carryBefore: formatPapUnits(carryBefore, 12), carryAfter: formatPapUnits(remainder, 12),
        commonAmount: formatPapUnits(credit), commonBalanceBefore: formatPapUnits(common), commonBalanceAfter: formatPapUnits(common + credit) },
    ]);
    if (credit > 0n) {
      await tx.insert(papLedgerTable).values({ corporationId, userId: targetId, userName: target.eveCharacterName ?? `#${targetId}`, type: "pap_conversion", amount: Number(formatPapUnits(credit)),
        balanceAfter: Number(formatPapUnits(common + credit)), lockedAfter: Number(formatPapUnits(locked)), availableAfter: Number(formatPapUnits(common + credit - locked)), reason: `${currency.name}：账号合并兑换尾数入账` });
    }
    common += credit;
  }
  if (common > MAX_PAP || locked > common) throw new PapCurrencyError(409, "PAP_AMOUNT_LIMIT", "合并后的 PAP 余额或冻结数量异常，请联系管理员。");
  await tx.update(usersTable).set({ redeemablePap: Number(formatPapUnits(common)), totalPap: Number(formatPapUnits(common)), lockedPap: Number(formatPapUnits(locked)), updatedAt: new Date() })
    .where(eq(usersTable.id, targetId));
  await tx.delete(papCurrencyWalletsTable).where(and(eq(papCurrencyWalletsTable.corporationId, corporationId), eq(papCurrencyWalletsTable.userId, sourceId)));
  return { source, target };
}
