import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

// No custom currency is seeded. Existing user balances remain the common PAP.
export const papCurrenciesTable = pgTable("pap_currencies", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  normalizedName: text("normalized_name").notNull(),
  description: text("description").notNull().default(""),
  rate: numeric("rate", { precision: 13, scale: 6 }).notNull(),
  issuanceEnabled: boolean("issuance_enabled").notNull().default(true),
  conversionEnabled: boolean("conversion_enabled").notNull().default(true),
  version: integer("version").notNull().default(0),
  createRequestId: text("create_request_id").notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("pap_currencies_corporation_id_unique").on(table.corporationId, table.id),
  uniqueIndex("pap_currencies_name_unique").on(table.corporationId, table.normalizedName),
  uniqueIndex("pap_currencies_create_request_unique").on(table.corporationId, table.createRequestId),
  check("pap_currencies_rate_valid", sql`${table.rate} > 0 AND ${table.rate} <= 1000000`),
  check("pap_currencies_version_valid", sql`${table.version} >= 0`),
  check("pap_currencies_name_valid", sql`length(${table.name}) BETWEEN 1 AND 40 AND length(${table.description}) <= 1000`),
]);

export const papCurrencyWalletsTable = pgTable("pap_currency_wallets", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  currencyId: integer("currency_id").notNull(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "restrict" }),
  balance: numeric("balance", { precision: 16, scale: 6 }).notNull().default("0"),
  // A remainder in common PAP (12 decimal places), always smaller than 1 micro-PAP.
  carry: numeric("carry", { precision: 13, scale: 12 }).notNull().default("0"),
  version: integer("version").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("pap_currency_wallets_owner_unique").on(table.corporationId, table.currencyId, table.userId),
  index("pap_currency_wallets_member_idx").on(table.corporationId, table.userId),
  foreignKey({ columns: [table.corporationId, table.currencyId], foreignColumns: [papCurrenciesTable.corporationId, papCurrenciesTable.id], name: "pap_currency_wallets_currency_fk" }).onDelete("restrict"),
  check("pap_currency_wallets_balance_valid", sql`${table.balance} >= 0 AND ${table.balance} <= 1000000000`),
  check("pap_currency_wallets_carry_valid", sql`${table.carry} >= 0 AND ${table.carry} < 0.000001`),
  check("pap_currency_wallets_version_valid", sql`${table.version} >= 0`),
]);

export const papCurrencyLedgerTable = pgTable("pap_currency_ledger", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  currencyId: integer("currency_id").notNull(),
  currencyName: text("currency_name").notNull(),
  currencyVersion: integer("currency_version").notNull(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
  userName: text("user_name").notNull(),
  type: text("type", { enum: ["award", "adjustment", "conversion", "account_merge"] }).notNull(),
  amount: numeric("amount", { precision: 16, scale: 6 }).notNull(),
  rate: numeric("rate", { precision: 13, scale: 6 }),
  commonAmount: numeric("common_amount", { precision: 16, scale: 6 }).notNull().default("0"),
  balanceBefore: numeric("balance_before", { precision: 16, scale: 6 }).notNull(),
  balanceAfter: numeric("balance_after", { precision: 16, scale: 6 }).notNull(),
  carryBefore: numeric("carry_before", { precision: 13, scale: 12 }).notNull(),
  carryAfter: numeric("carry_after", { precision: 13, scale: 12 }).notNull(),
  commonBalanceBefore: numeric("common_balance_before", { precision: 16, scale: 6 }),
  commonBalanceAfter: numeric("common_balance_after", { precision: 16, scale: 6 }),
  requestId: text("request_id"),
  requestFingerprint: text("request_fingerprint"),
  reason: text("reason").notNull(),
  fleetId: integer("fleet_id"),
  characterId: integer("character_id"),
  adminId: integer("admin_id").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  uniqueIndex("pap_currency_ledger_request_unique").on(table.corporationId, table.requestId),
  index("pap_currency_ledger_member_idx").on(table.corporationId, table.userId, table.createdAt),
  foreignKey({ columns: [table.corporationId, table.currencyId], foreignColumns: [papCurrenciesTable.corporationId, papCurrenciesTable.id], name: "pap_currency_ledger_currency_fk" }).onDelete("restrict"),
  check("pap_currency_ledger_type_valid", sql`${table.type} IN ('award','adjustment','conversion','account_merge')`),
  check("pap_currency_ledger_balances_valid", sql`${table.balanceBefore} >= 0 AND ${table.balanceAfter} >= 0 AND ${table.balanceBefore} <= 1000000000 AND ${table.balanceAfter} <= 1000000000 AND ${table.commonAmount} >= 0 AND ${table.commonAmount} <= 1000000000`),
  check("pap_currency_ledger_carry_valid", sql`${table.carryBefore} >= 0 AND ${table.carryBefore} < 0.000001 AND ${table.carryAfter} >= 0 AND ${table.carryAfter} < 0.000001`),
]);
