import { sql } from "drizzle-orm";
import { boolean, check, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

const priceBases = ["buy", "sell", "mid", "fixed"] as const;

export const buybackSettingsTable = pgTable("buyback_settings", {
  corporationId: integer("corporation_id").primaryKey().references(() => corporationsTable.id, { onDelete: "restrict" }),
  enabled: boolean("enabled").notNull().default(false),
  defaultEnabled: boolean("default_enabled").notNull().default(true),
  priceBasis: text("price_basis", { enum: priceBases }).notNull().default("buy"),
  ratePercent: numeric("rate_percent", { precision: 6, scale: 2 }).notNull().default("100.00"),
  fixedPrice: numeric("fixed_price", { precision: 18, scale: 2 }),
  quoteValidityMinutes: integer("quote_validity_minutes").notNull().default(30),
  version: integer("version").notNull().default(0),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check("buyback_settings_basis_check", sql`${table.priceBasis} IN ('buy', 'sell', 'mid', 'fixed')`),
  check("buyback_settings_rate_check", sql`${table.ratePercent} >= 0.01 AND ${table.ratePercent} <= 1000`),
  check("buyback_settings_fixed_check", sql`${table.fixedPrice} IS NULL OR (${table.fixedPrice} > 0 AND ${table.fixedPrice} <= 1000000000000000)`),
  check("buyback_settings_fixed_required", sql`${table.priceBasis} <> 'fixed' OR ${table.fixedPrice} IS NOT NULL`),
  check("buyback_settings_validity_check", sql`${table.quoteValidityMinutes} BETWEEN 1 AND 1440`),
  check("buyback_settings_version_check", sql`${table.version} >= 0`),
]);

export const buybackRulesTable = pgTable("buyback_rules", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  scope: text("scope", { enum: ["category", "type"] }).notNull(),
  targetId: integer("target_id").notNull(),
  targetName: text("target_name").notNull(),
  enabled: boolean("enabled"),
  priceBasis: text("price_basis", { enum: priceBases }),
  ratePercent: numeric("rate_percent", { precision: 6, scale: 2 }),
  fixedPrice: numeric("fixed_price", { precision: 18, scale: 2 }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("buyback_rules_target_unique").on(table.corporationId, table.scope, table.targetId),
  check("buyback_rules_scope_check", sql`${table.scope} IN ('type', 'category')`),
  check("buyback_rules_target_check", sql`${table.targetId} > 0`),
  check("buyback_rules_basis_check", sql`${table.priceBasis} IS NULL OR ${table.priceBasis} IN ('buy', 'sell', 'mid', 'fixed')`),
  check("buyback_rules_rate_check", sql`${table.ratePercent} IS NULL OR (${table.ratePercent} >= 0.01 AND ${table.ratePercent} <= 1000)`),
  check("buyback_rules_fixed_check", sql`${table.fixedPrice} IS NULL OR (${table.fixedPrice} > 0 AND ${table.fixedPrice} <= 1000000000000000)`),
]);

export const buybackQuotesTable = pgTable("buyback_quotes", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  submittedBy: integer("submitted_by").references(() => usersTable.id, { onDelete: "set null" }),
  submitterName: text("submitter_name").notNull(),
  inputText: text("input_text").notNull(),
  requestId: text("request_id").notNull(),
  totalIsk: numeric("total_isk", { precision: 22, scale: 2 }).notNull(),
  complete: boolean("complete").notNull(),
  settingsVersion: integer("settings_version").notNull(),
  settingsSnapshot: jsonb("settings_snapshot").notNull(),
  rulesSnapshot: jsonb("rules_snapshot").notNull(),
  lines: jsonb("lines").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  uniqueIndex("buyback_quotes_request_unique").on(table.corporationId, table.submittedBy, table.requestId),
  index("buyback_quotes_member_created_idx").on(table.corporationId, table.submittedBy, table.createdAt),
  index("buyback_quotes_corporation_created_idx").on(table.corporationId, table.createdAt),
  check("buyback_quotes_total_check", sql`${table.totalIsk} >= 0 AND ${table.totalIsk} <= 999999999999999999.99`),
  check("buyback_quotes_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  check("buyback_quotes_lines_check", sql`jsonb_typeof(${table.lines}) = 'array'`),
  check("buyback_quotes_line_count_check", sql`jsonb_array_length(${table.lines}) BETWEEN 1 AND 200`),
  check("buyback_quotes_input_length_check", sql`length(${table.inputText}) BETWEEN 1 AND 100000`),
  check("buyback_quotes_version_check", sql`${table.settingsVersion} >= 0`),
  check("buyback_quotes_request_check", sql`${table.requestId} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'`),
]);
