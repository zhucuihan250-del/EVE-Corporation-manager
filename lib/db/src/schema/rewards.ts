import { pgTable, text, serial, timestamp, integer, real, boolean, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const rewardsTable = pgTable("rewards", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  papCost: real("pap_cost").notNull(),
  stock: integer("stock"),
  eligibilityMonths: integer("eligibility_months"),
  isAvailable: boolean("is_available").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  check("rewards_eligibility_months_positive", sql`${table.eligibilityMonths} IS NULL OR ${table.eligibilityMonths} > 0`),
]);

export const insertRewardSchema = createInsertSchema(rewardsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReward = z.infer<typeof insertRewardSchema>;
export type Reward = typeof rewardsTable.$inferSelect;
