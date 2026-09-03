import { pgTable, text, serial, timestamp, integer, real, boolean, check, foreignKey, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { corporationsTable } from "./corporations";
import { identityGroupsTable } from "./identity_groups";

export const rewardsTable = pgTable("rewards", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  identityGroupId: integer("identity_group_id"),
  name: text("name").notNull(),
  description: text("description"),
  papCost: real("pap_cost").notNull(),
  stock: integer("stock"),
  eligibilityMonths: integer("eligibility_months"),
  maxRedemptionsPerUser: integer("max_redemptions_per_user"),
  isAvailable: boolean("is_available").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    name: "rewards_identity_group_corporation_fk",
    columns: [table.corporationId, table.identityGroupId],
    foreignColumns: [identityGroupsTable.corporationId, identityGroupsTable.id],
  }).onDelete("no action"),
  index("rewards_corporation_identity_group_idx").on(table.corporationId, table.identityGroupId),
  check("rewards_eligibility_months_positive", sql`${table.eligibilityMonths} IS NULL OR ${table.eligibilityMonths} > 0`),
  check("rewards_max_redemptions_per_user_positive", sql`${table.maxRedemptionsPerUser} IS NULL OR ${table.maxRedemptionsPerUser} > 0`),
]);

export const insertRewardSchema = createInsertSchema(rewardsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReward = z.infer<typeof insertRewardSchema>;
export type Reward = typeof rewardsTable.$inferSelect;
