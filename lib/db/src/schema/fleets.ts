import { pgTable, text, serial, timestamp, boolean, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const PING_TYPES = ["CTA", "Strategic", "Homedefense", "Roam", "Mining", "Other"] as const;
export type PingType = typeof PING_TYPES[number];

export const FLEET_STATUS = ["pending", "active", "finished"] as const;
export type FleetStatus = typeof FLEET_STATUS[number];

export const fleetsTable = pgTable("fleets", {
  id: serial("id").primaryKey(),
  eveFleetId: text("eve_fleet_id"),
  name: text("name").notNull(),
  fleetCommander: text("fleet_commander").notNull(),
  papValue: real("pap_value").notNull().default(1),
  isActive: boolean("is_active").notNull().default(true),
  pingType: text("ping_type"),
  status: text("status").notNull().default("active"),
  discordMessageId: text("discord_message_id"),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertFleetSchema = createInsertSchema(fleetsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertFleet = z.infer<typeof insertFleetSchema>;
export type Fleet = typeof fleetsTable.$inferSelect;
