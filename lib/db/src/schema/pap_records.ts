import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { charactersTable } from "./characters";
import { fleetsTable } from "./fleets";

export const papRecordsTable = pgTable("pap_records", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  characterId: integer("character_id").references(() => charactersTable.id, { onDelete: "set null" }),
  fleetId: integer("fleet_id").references(() => fleetsTable.id, { onDelete: "set null" }),
  amount: real("amount").notNull(),
  type: text("type", { enum: ["fleet", "manual", "adjustment"] }).notNull(),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertPapRecordSchema = createInsertSchema(papRecordsTable).omit({ id: true, createdAt: true });
export type InsertPapRecord = z.infer<typeof insertPapRecordSchema>;
export type PapRecord = typeof papRecordsTable.$inferSelect;
