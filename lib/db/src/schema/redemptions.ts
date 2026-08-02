import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { rewardsTable } from "./rewards";
import { corporationsTable } from "./corporations";

export const redemptionsTable = pgTable("redemptions", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  rewardId: integer("reward_id").notNull().references(() => rewardsTable.id, { onDelete: "cascade" }),
  rewardName: text("reward_name").notNull(),
  papCost: real("pap_cost").notNull(),
  status: text("status", { enum: ["pending", "fulfilled", "cancelled"] }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertRedemptionSchema = createInsertSchema(redemptionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertRedemption = z.infer<typeof insertRedemptionSchema>;
export type Redemption = typeof redemptionsTable.$inferSelect;
