import { doublePrecision, pgTable, text, serial, timestamp, integer, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { charactersTable } from "./characters";
import { fleetsTable } from "./fleets";
import { corporationsTable } from "./corporations";
import { papCurrenciesTable } from "./pap_currencies";

export const papRecordsTable = pgTable("pap_records", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id")
    .notNull()
    .references(() => corporationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  characterId: integer("character_id").references(() => charactersTable.id, { onDelete: "set null" }),
  fleetId: integer("fleet_id").references(() => fleetsTable.id, { onDelete: "set null" }),
  amount: doublePrecision("amount").notNull(),
  currencyId: integer("currency_id").references(() => papCurrenciesTable.id, { onDelete: "restrict" }),
  currencyName: text("currency_name"),
  type: text("type", { enum: ["fleet", "manual", "adjustment", "activity_deduction", "market_buy", "market_sell"] }).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("pap_records_fleet_character_currency_idx").on(table.fleetId, table.characterId, table.currencyId),
]);

export const insertPapRecordSchema = createInsertSchema(papRecordsTable).omit({ id: true, createdAt: true });
export type InsertPapRecord = z.infer<typeof insertPapRecordSchema>;
export type PapRecord = typeof papRecordsTable.$inferSelect;
