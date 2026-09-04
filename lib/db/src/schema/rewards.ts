import { pgTable, text, serial, timestamp, integer, real, boolean, check, foreignKey, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { corporationsTable } from "./corporations";
import { identityGroupSkillPlansTable, identityGroupsTable } from "./identity_groups";

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
  skillPlanMatchMode: text("skill_plan_match_mode", { enum: ["all", "any"] }).notNull().default("all"),
  isAvailable: boolean("is_available").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  foreignKey({
    name: "rewards_identity_group_corporation_fk",
    columns: [table.corporationId, table.identityGroupId],
    foreignColumns: [identityGroupsTable.corporationId, identityGroupsTable.id],
  }).onDelete("no action"),
  uniqueIndex("rewards_corporation_id_unique").on(table.corporationId, table.id),
  uniqueIndex("rewards_corporation_group_id_unique").on(table.corporationId, table.id, table.identityGroupId),
  index("rewards_corporation_identity_group_idx").on(table.corporationId, table.identityGroupId),
  check("rewards_skill_plan_match_mode_valid", sql`${table.skillPlanMatchMode} IN ('all', 'any')`),
  check("rewards_eligibility_months_positive", sql`${table.eligibilityMonths} IS NULL OR ${table.eligibilityMonths} > 0`),
  check("rewards_max_redemptions_per_user_positive", sql`${table.maxRedemptionsPerUser} IS NULL OR ${table.maxRedemptionsPerUser} > 0`),
]);

export const rewardSkillPlansTable = pgTable("reward_skill_plans", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  rewardId: integer("reward_id").notNull(),
  identityGroupId: integer("identity_group_id").notNull(),
  skillPlanId: integer("skill_plan_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  foreignKey({
    name: "reward_skill_plans_reward_group_fk",
    columns: [table.corporationId, table.rewardId, table.identityGroupId],
    foreignColumns: [rewardsTable.corporationId, rewardsTable.id, rewardsTable.identityGroupId],
  }).onDelete("cascade"),
  foreignKey({
    name: "reward_skill_plans_identity_group_plan_fk",
    columns: [table.corporationId, table.identityGroupId, table.skillPlanId],
    foreignColumns: [
      identityGroupSkillPlansTable.corporationId,
      identityGroupSkillPlansTable.groupId,
      identityGroupSkillPlansTable.skillPlanId,
    ],
  }).onDelete("no action"),
  uniqueIndex("reward_skill_plans_reward_plan_unique").on(table.corporationId, table.rewardId, table.skillPlanId),
  index("reward_skill_plans_group_plan_idx").on(table.corporationId, table.identityGroupId, table.skillPlanId),
]);

export const insertRewardSchema = createInsertSchema(rewardsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertReward = z.infer<typeof insertRewardSchema>;
export type Reward = typeof rewardsTable.$inferSelect;
