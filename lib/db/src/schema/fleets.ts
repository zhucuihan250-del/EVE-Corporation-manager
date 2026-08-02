import { pgTable, text, serial, timestamp, boolean, real, integer, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { corporationsTable } from "./corporations";

export type FleetReimbursementRule = {
  description?: string;
  maximumAmount?: number | null;
  eligibleShips?: string[];
};

export const fleetsTable = pgTable("fleets", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id")
    .notNull()
    .references(() => corporationsTable.id, { onDelete: "cascade" }),
  eveFleetId: text("eve_fleet_id"),
  name: text("name").notNull(),
  fleetCommander: text("fleet_commander").notNull(),
  papValue: real("pap_value").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  fleetFunction: text("fleet_function").notNull().default("general"),
  reimbursementEnabled: boolean("reimbursement_enabled").notNull().default(false),
  reimbursementRule: jsonb("reimbursement_rule").$type<FleetReimbursementRule | null>(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFleetSchema = createInsertSchema(fleetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFleet = z.infer<typeof insertFleetSchema>;
export type Fleet = typeof fleetsTable.$inferSelect;
