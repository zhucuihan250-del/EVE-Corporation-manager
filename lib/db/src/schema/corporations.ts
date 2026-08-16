import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./users";

export const corporationsTable = pgTable("corporations", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  isActive: boolean("is_active").notNull().default(true),
  papEnabled: boolean("pap_enabled").notNull().default(false),
  identityEnabled: boolean("identity_enabled").notNull().default(false),
  economyEnabled: boolean("economy_enabled").notNull().default(false),
  fleetEnabled: boolean("fleet_enabled").notNull().default(false),
  reimbursementEnabled: boolean("reimbursement_enabled").notNull().default(true),
  reimbursementOpen: boolean("reimbursement_open").notNull().default(true),
  diplomacyEnabled: boolean("diplomacy_enabled").notNull().default(true),
  courierEnabled: boolean("courier_enabled").notNull().default(false),
  structuresEnabled: boolean("structures_enabled").notNull().default(false),
  activityMinimumPap: doublePrecision("activity_minimum_pap").notNull().default(2),
  activityDeductionStartedAt: timestamp("activity_deduction_started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const corporationMembershipsTable = pgTable(
  "corporation_memberships",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["member", "fc", "admin", "controller"] })
      .notNull()
      .default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("corporation_memberships_corporation_user_unique").on(
      table.corporationId,
      table.userId,
    ),
  ],
);

export type Corporation = typeof corporationsTable.$inferSelect;
export type CorporationMembership = typeof corporationMembershipsTable.$inferSelect;
