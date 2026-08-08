import {
  integer,
  boolean,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { charactersTable } from "./characters";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export type RequiredSkill = {
  skillId: number;
  name: string;
  level: number;
};

export type SkillPlanAuditResult = {
  planId: number | null;
  name: string;
  passed: boolean;
  skills: Array<RequiredSkill & { trainedLevel: number; passed: boolean }>;
};

export type SkillAuditResult = {
  checkedAt: string;
  passed: boolean;
  skills: Array<RequiredSkill & { trainedLevel: number; passed: boolean }>;
  matchMode?: "all" | "any";
  plans?: SkillPlanAuditResult[];
};

export const corporationSkillPlansTable = pgTable(
  "corporation_skill_plans",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    requiredSkills: jsonb("required_skills")
      .$type<RequiredSkill[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("corporation_skill_plans_corporation_name_unique").on(
      table.corporationId,
      table.name,
    ),
    uniqueIndex("corporation_skill_plans_corporation_id_unique").on(
      table.corporationId,
      table.id,
    ),
  ],
);

export const identityGroupsTable = pgTable(
  "identity_groups",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    category: text("category", { enum: ["combat", "management"] }).notNull(),
    description: text("description").notNull().default(""),
    requiredSkills: jsonb("required_skills")
      .$type<RequiredSkill[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    permissions: jsonb("permissions")
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    skillPlanMatchMode: text("skill_plan_match_mode", { enum: ["all", "any"] })
      .notNull()
      .default("all"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("identity_groups_corporation_name_unique").on(
      table.corporationId,
      table.name,
    ),
  ],
);

export const identityGroupSkillPlansTable = pgTable(
  "identity_group_skill_plans",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => identityGroupsTable.id, { onDelete: "cascade" }),
    skillPlanId: integer("skill_plan_id")
      .notNull()
      .references(() => corporationSkillPlansTable.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_group_skill_plans_group_plan_unique").on(
      table.corporationId,
      table.groupId,
      table.skillPlanId,
    ),
  ],
);

export const identityGroupApplicationsTable = pgTable(
  "identity_group_applications",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => identityGroupsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    characterId: integer("character_id")
      .notNull()
      .references(() => charactersTable.id, { onDelete: "restrict" }),
    statement: text("statement").notNull().default(""),
    status: text("status", {
      enum: [
        "pending_skill_audit",
        "pending_review",
        "needs_information",
        "approved",
        "rejected",
        "withdrawn",
      ],
    })
      .notNull()
      .default("pending_skill_audit"),
    skillAudit: jsonb("skill_audit").$type<SkillAuditResult | null>(),
    rejectionReason: text("rejection_reason"),
    reviewerNotes: text("reviewer_notes"),
    reviewedBy: integer("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export const identityGroupMembershipsTable = pgTable(
  "identity_group_memberships",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    groupId: integer("group_id")
      .notNull()
      .references(() => identityGroupsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    characterId: integer("character_id").references(() => charactersTable.id, {
      onDelete: "set null",
    }),
    grantedBy: integer("granted_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("identity_group_memberships_group_user_unique").on(
      table.corporationId,
      table.groupId,
      table.userId,
    ),
  ],
);

export type IdentityGroup = typeof identityGroupsTable.$inferSelect;
export type IdentityGroupApplication = typeof identityGroupApplicationsTable.$inferSelect;
export type CorporationSkillPlan = typeof corporationSkillPlansTable.$inferSelect;
