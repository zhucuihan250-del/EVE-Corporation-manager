import { db, papLedgerTable } from "@workspace/db";
import { availablePap, canonicalLockedPap, canonicalPapBalance, normalizePap } from "./pap-balance";

type PapLedgerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function writePapLedger(
  tx: PapLedgerTransaction,
  data: {
    corporationId: number;
    userId: number;
    userName: string;
    amount?: number;
    lockedDelta?: number;
    type: typeof papLedgerTable.$inferInsert.type;
    orderId?: number | null;
    transactionId?: number | null;
    balanceAfter: number;
    lockedAfter: number;
    adminId?: number | null;
    reason?: string;
    createdAt?: Date;
  },
): Promise<void> {
  const balanceAfter = canonicalPapBalance(data.balanceAfter);
  const lockedAfter = canonicalLockedPap(data.lockedAfter, balanceAfter);
  await tx.insert(papLedgerTable).values({
    corporationId: data.corporationId,
    userId: data.userId,
    userName: data.userName,
    amount: normalizePap(data.amount ?? 0),
    lockedDelta: normalizePap(data.lockedDelta ?? 0),
    type: data.type,
    orderId: data.orderId ?? null,
    transactionId: data.transactionId ?? null,
    balanceAfter,
    lockedAfter,
    availableAfter: availablePap(balanceAfter, lockedAfter),
    adminId: data.adminId ?? null,
    reason: data.reason,
    createdAt: data.createdAt,
  });
}
