import type { db } from "@workspace/db";
import { fleetsTable, papCurrenciesTable, papRecordsTable, usersTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";
import { incrementPapBalance } from "./pap-balance";
import { writePapLedger } from "./pap-ledger";
import { awardCustomPap } from "./pap-currency-service";

type FleetPapTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class FleetPapError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

export function validateFleetPapValue(amount: number): void {
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000
      || !/^\d+(?:\.\d{1,6})?$/.test(String(amount))) {
    throw new FleetPapError("PAP 数量必须大于 0、不超过 1,000,000，且最多保留 6 位小数。");
  }
}

export async function lockFleetCurrency(tx: FleetPapTransaction, corporationId: number, currencyId: number | null) {
  if (currencyId === null) return null;
  if (!Number.isSafeInteger(currencyId) || currencyId <= 0) throw new FleetPapError("PAP 种类编号无效。");
  const [currency] = await tx.select().from(papCurrenciesTable).where(and(
    eq(papCurrenciesTable.id, currencyId), eq(papCurrenciesTable.corporationId, corporationId),
  )).for("update");
  if (!currency) throw new FleetPapError("PAP 种类不存在。", 404);
  if (!currency.issuanceEnabled) throw new FleetPapError("该 PAP 种类已暂停发放，请联系管理员。", 409);
  return currency;
}

/** Caller already holds the fleet row lock, also taken by all award paths. */
export async function fleetCurrencyUpdate(tx: FleetPapTransaction, fleet: typeof fleetsTable.$inferSelect, currencyId: number | null) {
  if (currencyId === fleet.papCurrencyId) return { papCurrencyId: currencyId };
  const [awarded] = await tx.select({ id: papRecordsTable.id }).from(papRecordsTable).where(and(
    eq(papRecordsTable.fleetId, fleet.id), eq(papRecordsTable.type, "fleet"),
  )).limit(1);
  if (awarded) throw new FleetPapError("舰队已发放 PAP，不能更改 PAP 种类。请创建新舰队。", 409);
  const currency = await lockFleetCurrency(tx, fleet.corporationId, currencyId);
  return { papCurrencyId: currency?.id ?? null, papCurrencyName: currency?.name ?? null };
}

/** The fleet lock serializes scans, manual participants, and currency changes. */
export async function awardFleetPap(tx: FleetPapTransaction, input: {
  fleetId: number;
  corporationId: number;
  character: { id: number; userId: number; eveCharacterName: string };
  adminId: number;
  expectedEveFleetId?: string;
}) {
  const [fleet] = await tx.select().from(fleetsTable).where(and(
    eq(fleetsTable.id, input.fleetId), eq(fleetsTable.corporationId, input.corporationId),
  )).for("update");
  if (!fleet) throw new FleetPapError("Fleet not found", 404);
  if (!fleet.isActive) throw new FleetPapError("Fleet is not active");
  if (input.expectedEveFleetId !== undefined && fleet.eveFleetId !== input.expectedEveFleetId) {
    throw new FleetPapError("舰队编号已更改，请重新扫描。", 409);
  }
  const [previous] = await tx.select().from(papRecordsTable).where(and(
    eq(papRecordsTable.fleetId, fleet.id), eq(papRecordsTable.characterId, input.character.id),
    eq(papRecordsTable.type, "fleet"),
  )).limit(1);
  if (previous) return { awarded: false as const, record: previous, fleet };

  const reason = `Fleet: ${fleet.name}`;
  let currencyName: string | null = null;
  if (fleet.papCurrencyId !== null) {
    validateFleetPapValue(fleet.papValue);
    const currency = await lockFleetCurrency(tx, input.corporationId, fleet.papCurrencyId);
    currencyName = currency!.name;
    await awardCustomPap(tx, {
      corporationId: input.corporationId, userId: input.character.userId,
      userName: input.character.eveCharacterName, currencyId: fleet.papCurrencyId,
      amount: fleet.papValue, reason, fleetId: fleet.id, characterId: input.character.id,
      adminId: input.adminId,
    });
  } else {
    const [updatedUser] = await tx.update(usersTable).set(incrementPapBalance(fleet.papValue))
      .where(eq(usersTable.id, input.character.userId))
      .returning({ redeemablePap: usersTable.redeemablePap, lockedPap: usersTable.lockedPap });
    if (!updatedUser) throw new FleetPapError("PAP award target no longer exists", 404);
    await writePapLedger(tx, {
      corporationId: input.corporationId, userId: input.character.userId,
      userName: input.character.eveCharacterName, amount: fleet.papValue, type: "pap_earned",
      balanceAfter: updatedUser.redeemablePap, lockedAfter: updatedUser.lockedPap, reason,
    });
  }
  const [record] = await tx.insert(papRecordsTable).values({
    corporationId: input.corporationId, userId: input.character.userId,
    characterId: input.character.id, fleetId: fleet.id, amount: fleet.papValue,
    currencyId: fleet.papCurrencyId, currencyName, type: "fleet", reason,
  }).returning();
  return { awarded: true as const, record, fleet };
}
