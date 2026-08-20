import { Router, type IRouter, type Request, type Response } from "express";
import {
  db,
  papLedgerTable,
  papMarketAdminLogsTable,
  papMarketOrdersTable,
  papMarketTransactionsTable,
  papRecordsTable,
  usersTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  CreatePapMarketOrderBody,
  ReviewPapMarketTransactionBody,
  TakePapMarketOrderBody,
} from "@workspace/api-zod";
import { requireAuth, hasRole } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { availablePap, canonicalPapBalance, canonicalLockedPap, normalizePap } from "../lib/pap-balance";
import { writePapLedger } from "../lib/pap-ledger";
import {
  calculatePapMarketIskValue,
  nextPapMarketOrderStatus,
  normalizeMarketPap,
  settlePapTransfer,
} from "../lib/pap-market-rules";

const router: IRouter = Router();
router.use("/pap-market", requireAuth, requireTenant, requireModule("pap"));

const ACTIVE_ORDER_STATUSES = ["open", "partially_filled"] as const;
const REVIEWABLE_TRANSACTION_STATUSES = ["pending_admin", "disputed"] as const;

class MarketError extends Error {
  constructor(readonly statusCode: number, message: string, readonly code: string) {
    super(message);
    this.name = "MarketError";
  }
}

function parsePositiveId(value: string | string[] | undefined, label: string): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new MarketError(400, `Invalid ${label}`, "INVALID_ID");
  }
  return parsed;
}

function marketAmount(value: number): number {
  try {
    return normalizeMarketPap(value);
  } catch {
    throw new MarketError(400, "PAP amount must be greater than zero", "INVALID_AMOUNT");
  }
}

function iskValue(amount: number): number {
  try {
    return calculatePapMarketIskValue(amount);
  } catch {
    throw new MarketError(400, "PAP amount is outside the supported range", "INVALID_AMOUNT");
  }
}

function actorName(req: Request): string {
  return req.tenant!.actorCharacter?.eveCharacterName
    ?? req.tenant!.user.eveCharacterName
    ?? `User ${req.tenant!.user.id}`;
}

function formatOrder(order: typeof papMarketOrdersTable.$inferSelect) {
  return {
    id: order.id,
    corporationId: order.corporationId,
    ownerId: order.ownerId,
    ownerName: order.ownerName,
    type: order.type,
    originalAmount: order.originalAmount,
    remainingAmount: order.remainingAmount,
    matchedAmount: order.matchedAmount,
    lockedPapAmount: order.lockedPapAmount,
    status: order.status,
    totalIskValue: iskValue(order.originalAmount),
    remainingIskValue: order.remainingAmount > 0 ? iskValue(order.remainingAmount) : 0,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
    expiresAt: order.expiresAt,
  };
}

function formatTransaction(transaction: typeof papMarketTransactionsTable.$inferSelect) {
  return {
    id: transaction.id,
    corporationId: transaction.corporationId,
    orderId: transaction.orderId,
    orderType: transaction.orderType,
    buyerId: transaction.buyerId,
    buyerName: transaction.buyerName,
    sellerId: transaction.sellerId,
    sellerName: transaction.sellerName,
    papAmount: transaction.papAmount,
    iskValue: Number(transaction.iskValue),
    status: transaction.status,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    reviewedAt: transaction.reviewedAt,
    reviewedBy: transaction.reviewedBy,
    adminNote: transaction.adminNote,
  };
}

function wallet(user: Pick<typeof usersTable.$inferSelect, "redeemablePap" | "lockedPap">) {
  const totalPap = canonicalPapBalance(user.redeemablePap);
  const lockedPap = canonicalLockedPap(user.lockedPap, totalPap);
  return { totalPap, availablePap: availablePap(totalPap, lockedPap), lockedPap };
}

function sendMarketError(res: Response, error: unknown): boolean {
  if (!(error instanceof MarketError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function loadOverview(corporationId: number, userId: number) {
  const [currentUser] = await db.select({
    redeemablePap: usersTable.redeemablePap,
    lockedPap: usersTable.lockedPap,
  }).from(usersTable).where(eq(usersTable.id, userId));
  if (!currentUser) throw new MarketError(401, "User not found", "USER_NOT_FOUND");

  const activeStatus = or(
    eq(papMarketOrdersTable.status, ACTIVE_ORDER_STATUSES[0]),
    eq(papMarketOrdersTable.status, ACTIVE_ORDER_STATUSES[1]),
  );
  const [sellOrders, buyOrders, myOrders, myTransactions, history, myLedger] = await Promise.all([
    db.select().from(papMarketOrdersTable).where(and(
      eq(papMarketOrdersTable.corporationId, corporationId),
      eq(papMarketOrdersTable.type, "sell"),
      activeStatus,
    )).orderBy(asc(papMarketOrdersTable.createdAt)).limit(200),
    db.select().from(papMarketOrdersTable).where(and(
      eq(papMarketOrdersTable.corporationId, corporationId),
      eq(papMarketOrdersTable.type, "buy"),
      activeStatus,
    )).orderBy(asc(papMarketOrdersTable.createdAt)).limit(200),
    db.select().from(papMarketOrdersTable).where(and(
      eq(papMarketOrdersTable.corporationId, corporationId),
      eq(papMarketOrdersTable.ownerId, userId),
    )).orderBy(desc(papMarketOrdersTable.createdAt)).limit(200),
    db.select().from(papMarketTransactionsTable).where(and(
      eq(papMarketTransactionsTable.corporationId, corporationId),
      or(eq(papMarketTransactionsTable.buyerId, userId), eq(papMarketTransactionsTable.sellerId, userId)),
    )).orderBy(desc(papMarketTransactionsTable.createdAt)).limit(200),
    db.select().from(papMarketTransactionsTable).where(and(
      eq(papMarketTransactionsTable.corporationId, corporationId),
      eq(papMarketTransactionsTable.status, "completed"),
    )).orderBy(desc(papMarketTransactionsTable.reviewedAt)).limit(200),
    db.select().from(papLedgerTable).where(and(
      eq(papLedgerTable.corporationId, corporationId),
      eq(papLedgerTable.userId, userId),
    )).orderBy(desc(papLedgerTable.createdAt)).limit(200),
  ]);

  return {
    wallet: wallet(currentUser),
    sellOrders: sellOrders.map(formatOrder),
    buyOrders: buyOrders.map(formatOrder),
    myOrders: myOrders.map(formatOrder),
    myTransactions: myTransactions.map(formatTransaction),
    history: history.map(formatTransaction),
    ledger: myLedger,
  };
}

// GET /api/pap-market/overview
router.get("/pap-market/overview", async (req: Request, res: Response): Promise<void> => {
  try {
    res.json(await loadOverview(req.tenant!.corporation.id, req.tenant!.user.id));
  } catch (error) {
    if (!sendMarketError(res, error)) throw error;
  }
});

// POST /api/pap-market/orders
router.post("/pap-market/orders", async (req: Request, res: Response): Promise<void> => {
  const body = CreatePapMarketOrderBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message, code: "INVALID_REQUEST" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const ownerId = req.tenant!.user.id;
  const ownerName = actorName(req);
  const amount = marketAmount(body.data.amount);

  try {
    const order = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${corporationId}:order:${ownerId}:${body.data.requestId}`}))`);
      const [replayed] = await tx.select().from(papMarketOrdersTable).where(and(
        eq(papMarketOrdersTable.corporationId, corporationId),
        eq(papMarketOrdersTable.ownerId, ownerId),
        eq(papMarketOrdersTable.clientRequestId, body.data.requestId),
      ));
      if (replayed) {
        if (replayed.type !== body.data.type || normalizePap(replayed.originalAmount) !== amount) {
          throw new MarketError(409, "Request ID was already used for a different order", "REQUEST_REPLAY_CONFLICT");
        }
        return replayed;
      }

      let owner: Pick<typeof usersTable.$inferSelect, "redeemablePap" | "lockedPap"> | null = null;
      if (body.data.type === "sell") {
        [owner] = await tx.select({
          redeemablePap: usersTable.redeemablePap,
          lockedPap: usersTable.lockedPap,
        }).from(usersTable).where(eq(usersTable.id, ownerId)).for("update");
        if (!owner) throw new MarketError(404, "User not found", "USER_NOT_FOUND");
        if (availablePap(owner.redeemablePap, owner.lockedPap) < amount) {
          throw new MarketError(400, "Insufficient available PAP", "INSUFFICIENT_AVAILABLE_PAP");
        }
      }

      const [created] = await tx.insert(papMarketOrdersTable).values({
        corporationId,
        ownerId,
        ownerName,
        type: body.data.type,
        originalAmount: amount,
        remainingAmount: amount,
        matchedAmount: 0,
        lockedPapAmount: body.data.type === "sell" ? amount : 0,
        status: "open",
        clientRequestId: body.data.requestId,
      }).returning();

      if (body.data.type === "sell" && owner) {
        const nextLocked = normalizePap(owner.lockedPap + amount);
        await tx.update(usersTable).set({ lockedPap: nextLocked }).where(eq(usersTable.id, ownerId));
        await writePapLedger(tx, {
          corporationId,
          userId: ownerId,
          userName: ownerName,
          type: "market_order_lock",
          orderId: created.id,
          lockedDelta: amount,
          balanceAfter: owner.redeemablePap,
          lockedAfter: nextLocked,
          reason: `SELL order #${created.id}`,
        });
      }
      return created;
    });
    res.status(201).json(formatOrder(order));
  } catch (error) {
    if (!sendMarketError(res, error)) throw error;
  }
});

// POST /api/pap-market/orders/:id/take
router.post("/pap-market/orders/:id/take", async (req: Request, res: Response): Promise<void> => {
  const body = TakePapMarketOrderBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message, code: "INVALID_REQUEST" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const actorId = req.tenant!.user.id;
  const takerName = actorName(req);

  try {
    const orderId = parsePositiveId(req.params.id, "order ID");
    const amount = marketAmount(body.data.amount);
    const transaction = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`${corporationId}:take:${body.data.requestId}`}))`);
      const [replayed] = await tx.select().from(papMarketTransactionsTable).where(and(
        eq(papMarketTransactionsTable.corporationId, corporationId),
        eq(papMarketTransactionsTable.requestId, body.data.requestId),
      ));
      if (replayed) {
        const isParty = replayed.buyerId === actorId || replayed.sellerId === actorId;
        if (!isParty || replayed.orderId !== orderId || normalizePap(replayed.papAmount) !== amount) {
          throw new MarketError(409, "Request ID was already used for a different transaction", "REQUEST_REPLAY_CONFLICT");
        }
        return replayed;
      }

      const [order] = await tx.select().from(papMarketOrdersTable).where(and(
        eq(papMarketOrdersTable.corporationId, corporationId),
        eq(papMarketOrdersTable.id, orderId),
      )).for("update");
      if (!order) throw new MarketError(404, "Order not found", "ORDER_NOT_FOUND");
      if (order.ownerId === actorId) throw new MarketError(400, "You cannot accept your own order", "OWN_ORDER");
      if (!ACTIVE_ORDER_STATUSES.includes(order.status as typeof ACTIVE_ORDER_STATUSES[number])) {
        throw new MarketError(409, "Order is no longer open", "ORDER_NOT_OPEN");
      }
      if (amount > normalizePap(order.remainingAmount)) {
        throw new MarketError(409, "Requested PAP exceeds the order remaining amount", "ORDER_AMOUNT_EXCEEDED");
      }

      let buyerId: number;
      let buyerName: string;
      let sellerId: number;
      let sellerName: string;
      let seller: Pick<typeof usersTable.$inferSelect, "redeemablePap" | "lockedPap"> | null = null;
      if (order.type === "buy") {
        buyerId = order.ownerId;
        buyerName = order.ownerName;
        sellerId = actorId;
        sellerName = takerName;
        [seller] = await tx.select({
          redeemablePap: usersTable.redeemablePap,
          lockedPap: usersTable.lockedPap,
        }).from(usersTable).where(eq(usersTable.id, sellerId)).for("update");
        if (!seller) throw new MarketError(404, "Seller not found", "USER_NOT_FOUND");
        if (availablePap(seller.redeemablePap, seller.lockedPap) < amount) {
          throw new MarketError(400, "Insufficient available PAP", "INSUFFICIENT_AVAILABLE_PAP");
        }
      } else {
        buyerId = actorId;
        buyerName = takerName;
        sellerId = order.ownerId;
        sellerName = order.ownerName;
      }

      const remainingAmount = normalizePap(order.remainingAmount - amount);
      const matchedAmount = normalizePap(order.matchedAmount + amount);
      const lockedPapAmount = order.type === "sell"
        ? normalizePap(order.lockedPapAmount - amount)
        : order.lockedPapAmount;
      await tx.update(papMarketOrdersTable).set({
        remainingAmount,
        matchedAmount,
        lockedPapAmount,
        status: nextPapMarketOrderStatus(remainingAmount, matchedAmount),
        updatedAt: new Date(),
      }).where(and(eq(papMarketOrdersTable.corporationId, corporationId), eq(papMarketOrdersTable.id, order.id)));

      const [created] = await tx.insert(papMarketTransactionsTable).values({
        corporationId,
        orderId: order.id,
        orderType: order.type,
        buyerId,
        buyerName,
        sellerId,
        sellerName,
        papAmount: amount,
        iskValue: iskValue(amount),
        status: "pending_admin",
        requestId: body.data.requestId,
      }).returning();

      if (order.type === "buy" && seller) {
        const nextLocked = normalizePap(seller.lockedPap + amount);
        await tx.update(usersTable).set({ lockedPap: nextLocked }).where(eq(usersTable.id, sellerId));
        await writePapLedger(tx, {
          corporationId,
          userId: sellerId,
          userName: sellerName,
          type: "market_transaction_lock",
          orderId: order.id,
          transactionId: created.id,
          lockedDelta: amount,
          balanceAfter: seller.redeemablePap,
          lockedAfter: nextLocked,
          reason: `Accepted BUY order #${order.id}`,
        });
      } else {
        const [sellerState] = await tx.select({
          redeemablePap: usersTable.redeemablePap,
          lockedPap: usersTable.lockedPap,
        }).from(usersTable).where(eq(usersTable.id, sellerId));
        if (!sellerState) throw new MarketError(404, "Seller not found", "USER_NOT_FOUND");
        await writePapLedger(tx, {
          corporationId,
          userId: sellerId,
          userName: sellerName,
          type: "market_transaction_lock",
          orderId: order.id,
          transactionId: created.id,
          balanceAfter: sellerState.redeemablePap,
          lockedAfter: sellerState.lockedPap,
          reason: `Reserved from SELL order #${order.id}`,
        });
      }
      return created;
    });
    res.status(201).json(formatTransaction(transaction));
  } catch (error) {
    if (!sendMarketError(res, error)) throw error;
  }
});

// POST /api/pap-market/orders/:id/cancel
router.post("/pap-market/orders/:id/cancel", async (req: Request, res: Response): Promise<void> => {
  const corporationId = req.tenant!.corporation.id;
  const ownerId = req.tenant!.user.id;
  try {
    const orderId = parsePositiveId(req.params.id, "order ID");
    const order = await db.transaction(async (tx) => {
      const [lockedOrder] = await tx.select().from(papMarketOrdersTable).where(and(
        eq(papMarketOrdersTable.corporationId, corporationId),
        eq(papMarketOrdersTable.id, orderId),
      )).for("update");
      if (!lockedOrder) throw new MarketError(404, "Order not found", "ORDER_NOT_FOUND");
      if (lockedOrder.ownerId !== ownerId) throw new MarketError(403, "You can only cancel your own order", "FORBIDDEN");
      if (lockedOrder.status === "cancelled") return lockedOrder;
      if (!ACTIVE_ORDER_STATUSES.includes(lockedOrder.status as typeof ACTIVE_ORDER_STATUSES[number])) {
        throw new MarketError(409, "Only open orders can be cancelled", "ORDER_NOT_OPEN");
      }

      if (lockedOrder.type === "sell" && lockedOrder.lockedPapAmount > 0) {
        const [owner] = await tx.select({
          redeemablePap: usersTable.redeemablePap,
          lockedPap: usersTable.lockedPap,
        }).from(usersTable).where(eq(usersTable.id, ownerId)).for("update");
        if (!owner || owner.lockedPap < lockedOrder.lockedPapAmount) {
          throw new MarketError(409, "Locked PAP balance is inconsistent", "LOCKED_BALANCE_INCONSISTENT");
        }
        const nextLocked = normalizePap(owner.lockedPap - lockedOrder.lockedPapAmount);
        await tx.update(usersTable).set({ lockedPap: nextLocked }).where(eq(usersTable.id, ownerId));
        await writePapLedger(tx, {
          corporationId,
          userId: ownerId,
          userName: lockedOrder.ownerName,
          type: "market_order_unlock",
          orderId: lockedOrder.id,
          lockedDelta: -lockedOrder.lockedPapAmount,
          balanceAfter: owner.redeemablePap,
          lockedAfter: nextLocked,
          reason: `Cancelled SELL order #${lockedOrder.id}`,
        });
      }

      const [cancelled] = await tx.update(papMarketOrdersTable).set({
        status: "cancelled",
        lockedPapAmount: 0,
        cancelledAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(papMarketOrdersTable.corporationId, corporationId),
        eq(papMarketOrdersTable.id, lockedOrder.id),
      )).returning();
      return cancelled;
    });
    res.json(formatOrder(order));
  } catch (error) {
    if (!sendMarketError(res, error)) throw error;
  }
});

async function loadAdminOverview(corporationId: number) {
  const [transactions, orders, logs, ledgerEntries] = await Promise.all([
    db.select().from(papMarketTransactionsTable)
      .where(eq(papMarketTransactionsTable.corporationId, corporationId))
      .orderBy(desc(papMarketTransactionsTable.createdAt)).limit(500),
    db.select().from(papMarketOrdersTable)
      .where(eq(papMarketOrdersTable.corporationId, corporationId))
      .orderBy(desc(papMarketOrdersTable.createdAt)).limit(500),
    db.select().from(papMarketAdminLogsTable)
      .where(eq(papMarketAdminLogsTable.corporationId, corporationId))
      .orderBy(desc(papMarketAdminLogsTable.createdAt)).limit(500),
    db.select().from(papLedgerTable)
      .where(eq(papLedgerTable.corporationId, corporationId))
      .orderBy(desc(papLedgerTable.createdAt)).limit(500),
  ]);
  return {
    transactions: transactions.map(formatTransaction),
    orders: orders.map(formatOrder),
    adminLogs: logs,
    ledger: ledgerEntries,
  };
}

// GET /api/pap-market/admin/overview
router.get("/pap-market/admin/overview", async (req: Request, res: Response): Promise<void> => {
  if (!hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(await loadAdminOverview(req.tenant!.corporation.id));
});

// PATCH /api/pap-market/admin/transactions/:id
router.patch("/pap-market/admin/transactions/:id", async (req: Request, res: Response): Promise<void> => {
  if (!hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const body = ReviewPapMarketTransactionBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message, code: "INVALID_REQUEST" });
    return;
  }
  const reviewNote = body.data.note?.trim() ?? "";
  if ((body.data.action === "reject" || body.data.action === "dispute") && !reviewNote) {
    res.status(400).json({ error: "A note is required for rejection or dispute", code: "NOTE_REQUIRED" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const adminId = req.tenant!.user.id;

  try {
    const transactionId = parsePositiveId(req.params.id, "transaction ID");
    const result = await db.transaction(async (tx) => {
      const [transaction] = await tx.select().from(papMarketTransactionsTable).where(and(
        eq(papMarketTransactionsTable.corporationId, corporationId),
        eq(papMarketTransactionsTable.id, transactionId),
      )).for("update");
      if (!transaction) throw new MarketError(404, "Transaction not found", "TRANSACTION_NOT_FOUND");
      if (body.data.action === "approve" && transaction.status === "completed") return transaction;
      if (body.data.action === "reject" && transaction.status === "rejected") return transaction;
      if (body.data.action === "dispute" && transaction.status === "disputed") return transaction;
      if (!REVIEWABLE_TRANSACTION_STATUSES.includes(transaction.status as typeof REVIEWABLE_TRANSACTION_STATUSES[number])) {
        throw new MarketError(409, "Transaction has already been finalized", "TRANSACTION_FINALIZED");
      }

      const [order] = await tx.select().from(papMarketOrdersTable).where(and(
        eq(papMarketOrdersTable.corporationId, corporationId),
        eq(papMarketOrdersTable.id, transaction.orderId),
      )).for("update");
      if (!order) throw new MarketError(409, "Related order is unavailable", "ORDER_NOT_FOUND");

      const beforeState = { transaction, order };
      let updatedOrder = order;
      let nextStatus: "completed" | "rejected" | "disputed";

      if (body.data.action === "approve") {
        const participants = await tx.select().from(usersTable)
          .where(inArray(usersTable.id, [transaction.buyerId, transaction.sellerId]))
          .orderBy(asc(usersTable.id)).for("update");
        const seller = participants.find((user) => user.id === transaction.sellerId);
        const buyer = participants.find((user) => user.id === transaction.buyerId);
        if (!seller || !buyer) throw new MarketError(409, "Buyer or seller is unavailable", "USER_NOT_FOUND");
        if (seller.lockedPap < transaction.papAmount || seller.redeemablePap < transaction.papAmount) {
          throw new MarketError(409, "Seller locked PAP is insufficient", "LOCKED_BALANCE_INCONSISTENT");
        }

        const { sellerBalance, sellerLocked, buyerBalance } = settlePapTransfer({
          sellerBalance: seller.redeemablePap,
          sellerLocked: seller.lockedPap,
          buyerBalance: buyer.redeemablePap,
          amount: transaction.papAmount,
        });
        await tx.update(usersTable).set({
          totalPap: sellerBalance,
          redeemablePap: sellerBalance,
          lockedPap: sellerLocked,
        }).where(eq(usersTable.id, seller.id));
        await tx.update(usersTable).set({
          totalPap: buyerBalance,
          redeemablePap: buyerBalance,
        }).where(eq(usersTable.id, buyer.id));

        await tx.insert(papRecordsTable).values([
          {
            corporationId,
            userId: seller.id,
            amount: -transaction.papAmount,
            type: "market_sell",
            reason: `PAP Market transaction #${transaction.id}`,
          },
          {
            corporationId,
            userId: buyer.id,
            amount: transaction.papAmount,
            type: "market_buy",
            reason: `PAP Market transaction #${transaction.id}`,
          },
        ]);
        await writePapLedger(tx, {
          corporationId,
          userId: seller.id,
          userName: transaction.sellerName,
          type: "market_sell",
          orderId: order.id,
          transactionId: transaction.id,
          amount: -transaction.papAmount,
          lockedDelta: -transaction.papAmount,
          balanceAfter: sellerBalance,
          lockedAfter: sellerLocked,
          adminId,
          reason: `Approved transaction #${transaction.id}`,
        });
        await writePapLedger(tx, {
          corporationId,
          userId: buyer.id,
          userName: transaction.buyerName,
          type: "market_buy",
          orderId: order.id,
          transactionId: transaction.id,
          amount: transaction.papAmount,
          balanceAfter: buyerBalance,
          lockedAfter: buyer.lockedPap,
          adminId,
          reason: `Approved transaction #${transaction.id}`,
        });
        nextStatus = "completed";
      } else if (body.data.action === "reject") {
        const [seller] = await tx.select().from(usersTable)
          .where(eq(usersTable.id, transaction.sellerId)).for("update");
        if (!seller || seller.lockedPap < transaction.papAmount) {
          throw new MarketError(409, "Seller locked PAP is insufficient", "LOCKED_BALANCE_INCONSISTENT");
        }
        const restoreOrder = order.status !== "cancelled" && order.status !== "expired";
        let nextLocked = seller.lockedPap;
        if (transaction.orderType === "buy" || !restoreOrder) {
          nextLocked = normalizePap(seller.lockedPap - transaction.papAmount);
          await tx.update(usersTable).set({ lockedPap: nextLocked }).where(eq(usersTable.id, seller.id));
        }
        if (restoreOrder) {
          const remainingAmount = normalizePap(order.remainingAmount + transaction.papAmount);
          const matchedAmount = normalizePap(order.matchedAmount - transaction.papAmount);
          const lockedPapAmount = transaction.orderType === "sell"
            ? normalizePap(order.lockedPapAmount + transaction.papAmount)
            : order.lockedPapAmount;
          [updatedOrder] = await tx.update(papMarketOrdersTable).set({
            remainingAmount,
            matchedAmount,
            lockedPapAmount,
            status: nextPapMarketOrderStatus(remainingAmount, matchedAmount),
            updatedAt: new Date(),
          }).where(and(
            eq(papMarketOrdersTable.corporationId, corporationId),
            eq(papMarketOrdersTable.id, order.id),
          )).returning();
        }
        await writePapLedger(tx, {
          corporationId,
          userId: seller.id,
          userName: transaction.sellerName,
          type: restoreOrder && transaction.orderType === "sell" ? "reversal" : "market_transaction_unlock",
          orderId: order.id,
          transactionId: transaction.id,
          lockedDelta: normalizePap(nextLocked - seller.lockedPap),
          balanceAfter: seller.redeemablePap,
          lockedAfter: nextLocked,
          adminId,
          reason: restoreOrder
            ? `Rejected transaction #${transaction.id}; amount restored to order`
            : `Rejected transaction #${transaction.id}; PAP unlocked`,
        });
        nextStatus = "rejected";
      } else {
        nextStatus = "disputed";
      }

      const [updatedTransaction] = await tx.update(papMarketTransactionsTable).set({
        status: nextStatus,
        reviewedAt: new Date(),
        reviewedBy: adminId,
        adminNote: reviewNote || null,
        updatedAt: new Date(),
      }).where(and(
        eq(papMarketTransactionsTable.corporationId, corporationId),
        eq(papMarketTransactionsTable.id, transaction.id),
      )).returning();

      await tx.insert(papMarketAdminLogsTable).values({
        corporationId,
        adminId,
        action: body.data.action,
        transactionId: transaction.id,
        orderId: order.id,
        beforeState,
        afterState: { transaction: updatedTransaction, order: updatedOrder },
        note: reviewNote || null,
      });
      return updatedTransaction;
    });
    res.json(formatTransaction(result));
  } catch (error) {
    if (!sendMarketError(res, error)) throw error;
  }
});

export default router;
