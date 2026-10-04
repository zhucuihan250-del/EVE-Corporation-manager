import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, jsonb, numeric, pgTable, serial, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";
import { charactersTable } from "./characters";
import { papCurrenciesTable } from "./pap_currencies";
import { papRecordsTable } from "./pap_records";

// No rule, currency, connection or award is seeded by this feature.
export const dutyPapRulesTable = pgTable("duty_pap_rules", {
  id: serial("id").primaryKey(), corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }),
  name: text("name").notNull(), eveFleetId: text("eve_fleet_id").notNull(), currencyId: integer("currency_id"),
  minutesPerAward: integer("minutes_per_award").notNull(), awardAmount: numeric("award_amount", { precision: 16, scale: 6 }).notNull(), dailyCap: numeric("daily_cap", { precision: 16, scale: 6 }).notNull(),
  solarSystemIds: jsonb("solar_system_ids").$type<number[]>().notNull().default([]), shipTypeIds: jsonb("ship_type_ids").$type<number[]>().notNull().default([]),
  requireUndocked: boolean("require_undocked").notNull().default(true), enabled: boolean("enabled").notNull().default(false), version: integer("version").notNull().default(0),
  createRequestId: text("create_request_id").notNull(), createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }), updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("duty_pap_rules_corp_id_unique").on(t.corporationId, t.id),
  uniqueIndex("duty_pap_rules_request_unique").on(t.corporationId, t.createRequestId),
  uniqueIndex("duty_pap_rules_active_fleet_unique").on(t.corporationId, t.eveFleetId).where(sql`${t.enabled} = true`),
  foreignKey({ columns: [t.corporationId, t.currencyId], foreignColumns: [papCurrenciesTable.corporationId, papCurrenciesTable.id], name: "duty_pap_rules_currency_fk" }).onDelete("restrict"),
  check("duty_pap_rules_values_valid", sql`${t.minutesPerAward} BETWEEN 1 AND 1440 AND ${t.awardAmount} > 0 AND ${t.awardAmount} <= 1000000 AND ${t.dailyCap} >= ${t.awardAmount} AND ${t.dailyCap} <= 1000000 AND ${t.version} >= 0`),
  check("duty_pap_rules_text_valid", sql`length(${t.name}) BETWEEN 1 AND 80 AND ${t.eveFleetId} ~ '^[1-9][0-9]{0,15}$'`),
]);

export const dutyPapConnectionsTable = pgTable("duty_pap_connections", {
  id: serial("id").primaryKey(), corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }), userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  characterId: integer("character_id").notNull(), accessToken: text("access_token"), refreshToken: text("refresh_token"), tokenExpiry: timestamp("token_expiry", { withTimezone: true }), scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  enabled: boolean("enabled").notNull().default(false), version: integer("version").notNull().default(0), contextChangedAt: timestamp("context_changed_at", { withTimezone: true }).notNull().defaultNow(),
  lastObservedAt: timestamp("last_observed_at", { withTimezone: true }), lastEligibleRuleId: integer("last_eligible_rule_id"), lastEligibleRuleVersion: integer("last_eligible_rule_version"), lastStatus: text("last_status").notNull().default("authorization_required"), statusMessage: text("status_message").notNull().default("尚未授权值守采集。"),
  lastFleetId: text("last_fleet_id"), lastSolarSystemId: integer("last_solar_system_id"), lastShipTypeId: integer("last_ship_type_id"), lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(), updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("duty_pap_connections_owner_unique").on(t.corporationId, t.userId),
  uniqueIndex("duty_pap_connections_corp_id_unique").on(t.corporationId, t.id),
  foreignKey({ columns: [t.characterId], foreignColumns: [charactersTable.id], name: "duty_pap_connections_character_fk" }).onDelete("cascade"),
  check("duty_pap_connections_version_valid", sql`${t.version} >= 0`),
]);

export const dutyPapProgressTable = pgTable("duty_pap_progress", {
  id: serial("id").primaryKey(), corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }), ruleId: integer("rule_id").notNull(), userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  day: text("day").notNull(), ruleVersion: integer("rule_version").notNull(), eligibleSeconds: integer("eligible_seconds").notNull().default(0), totalEligibleSeconds: integer("total_eligible_seconds").notNull().default(0), awardCount: integer("award_count").notNull().default(0), paidAmount: numeric("paid_amount", { precision: 16, scale: 6 }).notNull().default("0"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("duty_pap_progress_period_unique").on(t.corporationId, t.ruleId, t.userId, t.day),
  foreignKey({ columns: [t.corporationId, t.ruleId], foreignColumns: [dutyPapRulesTable.corporationId, dutyPapRulesTable.id], name: "duty_pap_progress_rule_fk" }).onDelete("restrict"),
  check("duty_pap_progress_values_valid", sql`${t.eligibleSeconds} >= 0 AND ${t.totalEligibleSeconds} >= 0 AND ${t.awardCount} >= 0 AND ${t.paidAmount} >= 0 AND ${t.ruleVersion} >= 0 AND ${t.day} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'`),
]);

export const dutyPapAwardsTable = pgTable("duty_pap_awards", {
  id: serial("id").primaryKey(), corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "restrict" }), ruleId: integer("rule_id").notNull(), userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }), userName: text("user_name").notNull(), characterName: text("character_name").notNull(),
  day: text("day").notNull(), awardIndex: integer("award_index").notNull(), ruleVersion: integer("rule_version").notNull(), ruleName: text("rule_name").notNull(), eveFleetId: text("eve_fleet_id").notNull(), minutesPerAward: integer("minutes_per_award").notNull(),
  amount: numeric("amount", { precision: 16, scale: 6 }).notNull(), currencyId: integer("currency_id"), currencyName: text("currency_name").notNull(), papRecordId: integer("pap_record_id").references(() => papRecordsTable.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [
  uniqueIndex("duty_pap_awards_period_unique").on(t.corporationId, t.ruleId, t.userId, t.day, t.awardIndex),
  index("duty_pap_awards_member_idx").on(t.corporationId, t.userId, t.id),
  foreignKey({ columns: [t.corporationId, t.ruleId], foreignColumns: [dutyPapRulesTable.corporationId, dutyPapRulesTable.id], name: "duty_pap_awards_rule_fk" }).onDelete("restrict"),
  foreignKey({ columns: [t.corporationId, t.currencyId], foreignColumns: [papCurrenciesTable.corporationId, papCurrenciesTable.id], name: "duty_pap_awards_currency_fk" }).onDelete("restrict"),
  check("duty_pap_awards_values_valid", sql`${t.awardIndex} > 0 AND ${t.ruleVersion} >= 0 AND ${t.amount} > 0 AND ${t.minutesPerAward} BETWEEN 1 AND 1440`),
]);
