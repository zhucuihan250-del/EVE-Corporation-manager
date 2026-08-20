import {
  bigint,
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export const papMarketOrdersTable = pgTable("pap_market_orders", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  ownerId: integer("owner_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  ownerName: text("owner_name").notNull(),
  type: text("type", { enum: ["buy", "sell"] }).notNull(),
  originalAmount: doublePrecision("original_amount").notNull(),
  remainingAmount: doublePrecision("remaining_amount").notNull(),
  matchedAmount: doublePrecision("matched_amount").notNull().default(0),
  lockedPapAmount: doublePrecision("locked_pap_amount").notNull().default(0),
  status: text("status", { enum: ["open", "partially_filled", "filled", "cancelled", "expired"] }).notNull().default("open"),
  clientRequestId: text("client_request_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("pap_market_orders_corporation_id_unique").on(table.corporationId, table.id),
  uniqueIndex("pap_market_orders_request_unique").on(table.corporationId, table.ownerId, table.clientRequestId),
  index("pap_market_orders_book_idx").on(table.corporationId, table.type, table.status, table.createdAt),
  index("pap_market_orders_owner_idx").on(table.corporationId, table.ownerId, table.createdAt),
  check("pap_market_orders_amounts_valid", sql`${table.originalAmount} > 0 AND ${table.remainingAmount} >= 0 AND ${table.matchedAmount} >= 0 AND ABS((${table.remainingAmount} + ${table.matchedAmount}) - ${table.originalAmount}) < 0.000001`),
  check("pap_market_orders_lock_valid", sql`${table.lockedPapAmount} >= 0 AND ${table.lockedPapAmount} <= ${table.remainingAmount}`),
]);

export const papMarketTransactionsTable = pgTable("pap_market_transactions", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  orderId: integer("order_id").notNull().references(() => papMarketOrdersTable.id, { onDelete: "restrict" }),
  orderType: text("order_type", { enum: ["buy", "sell"] }).notNull(),
  buyerId: integer("buyer_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  buyerName: text("buyer_name").notNull(),
  sellerId: integer("seller_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  sellerName: text("seller_name").notNull(),
  papAmount: doublePrecision("pap_amount").notNull(),
  iskValue: bigint("isk_value", { mode: "number" }).notNull(),
  status: text("status", { enum: ["pending_admin", "completed", "rejected", "disputed", "cancelled"] }).notNull().default("pending_admin"),
  requestId: text("request_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewedBy: integer("reviewed_by").references(() => usersTable.id, { onDelete: "restrict" }),
  adminNote: text("admin_note"),
}, (table) => [
  uniqueIndex("pap_market_transactions_corporation_id_unique").on(table.corporationId, table.id),
  uniqueIndex("pap_market_transactions_request_unique").on(table.corporationId, table.requestId),
  index("pap_market_transactions_status_idx").on(table.corporationId, table.status, table.createdAt),
  index("pap_market_transactions_buyer_idx").on(table.corporationId, table.buyerId, table.createdAt),
  index("pap_market_transactions_seller_idx").on(table.corporationId, table.sellerId, table.createdAt),
  foreignKey({
    columns: [table.corporationId, table.orderId],
    foreignColumns: [papMarketOrdersTable.corporationId, papMarketOrdersTable.id],
    name: "pap_market_transactions_corporation_order_fk",
  }).onDelete("restrict"),
  check("pap_market_transactions_amount_valid", sql`${table.papAmount} > 0 AND ${table.iskValue} > 0`),
  check("pap_market_transactions_parties_different", sql`${table.buyerId} <> ${table.sellerId}`),
]);

export const papLedgerTable = pgTable("pap_ledger", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  userName: text("user_name").notNull(),
  amount: doublePrecision("amount").notNull().default(0),
  lockedDelta: doublePrecision("locked_delta").notNull().default(0),
  type: text("type", { enum: ["opening_balance", "pap_earned", "redemption", "admin_adjustment", "activity_deduction", "account_merge", "market_order_lock", "market_order_unlock", "market_transaction_lock", "market_transaction_unlock", "market_buy", "market_sell", "reversal"] }).notNull(),
  orderId: integer("order_id").references(() => papMarketOrdersTable.id, { onDelete: "restrict" }),
  transactionId: integer("transaction_id").references(() => papMarketTransactionsTable.id, { onDelete: "restrict" }),
  balanceAfter: doublePrecision("balance_after").notNull(),
  lockedAfter: doublePrecision("locked_after").notNull(),
  availableAfter: doublePrecision("available_after").notNull(),
  adminId: integer("admin_id").references(() => usersTable.id, { onDelete: "restrict" }),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("pap_ledger_corporation_user_idx").on(table.corporationId, table.userId, table.createdAt),
  index("pap_ledger_corporation_transaction_idx").on(table.corporationId, table.transactionId),
  foreignKey({
    columns: [table.corporationId, table.orderId],
    foreignColumns: [papMarketOrdersTable.corporationId, papMarketOrdersTable.id],
    name: "pap_ledger_corporation_order_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.corporationId, table.transactionId],
    foreignColumns: [papMarketTransactionsTable.corporationId, papMarketTransactionsTable.id],
    name: "pap_ledger_corporation_transaction_fk",
  }).onDelete("restrict"),
  check("pap_ledger_balances_valid", sql`${table.balanceAfter} >= 0 AND ${table.lockedAfter} >= 0 AND ${table.availableAfter} >= 0 AND ${table.lockedAfter} <= ${table.balanceAfter}`),
]);

export const papMarketAdminLogsTable = pgTable("pap_market_admin_logs", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  action: text("action", { enum: ["approve", "reject", "dispute"] }).notNull(),
  transactionId: integer("transaction_id").notNull().references(() => papMarketTransactionsTable.id, { onDelete: "restrict" }),
  orderId: integer("order_id").notNull().references(() => papMarketOrdersTable.id, { onDelete: "restrict" }),
  beforeState: jsonb("before_state").notNull(),
  afterState: jsonb("after_state").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("pap_market_admin_logs_corporation_idx").on(table.corporationId, table.createdAt),
  foreignKey({
    columns: [table.corporationId, table.transactionId],
    foreignColumns: [papMarketTransactionsTable.corporationId, papMarketTransactionsTable.id],
    name: "pap_market_admin_logs_corporation_transaction_fk",
  }).onDelete("restrict"),
  foreignKey({
    columns: [table.corporationId, table.orderId],
    foreignColumns: [papMarketOrdersTable.corporationId, papMarketOrdersTable.id],
    name: "pap_market_admin_logs_corporation_order_fk",
  }).onDelete("restrict"),
]);

export type PapMarketOrder = typeof papMarketOrdersTable.$inferSelect;
export type PapMarketTransaction = typeof papMarketTransactionsTable.$inferSelect;
export type PapLedgerEntry = typeof papLedgerTable.$inferSelect;
export type PapMarketAdminLog = typeof papMarketAdminLogsTable.$inferSelect;
