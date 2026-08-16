import {
  doublePrecision,
  foreignKey,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { papRecordsTable } from "./pap_records";
import { usersTable } from "./users";

export const activityMonthlySettlementsTable = pgTable(
  "activity_monthly_settlements",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    minimumPap: doublePrecision("minimum_pap").notNull(),
    eligibleMemberCount: integer("eligible_member_count").notNull(),
    totalDeductedPap: doublePrecision("total_deducted_pap").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("activity_monthly_settlements_corporation_month_unique").on(
      table.corporationId,
      table.month,
    ),
    uniqueIndex("activity_monthly_settlements_corporation_id_unique").on(
      table.corporationId,
      table.id,
    ),
  ],
);

export const activityMonthlyDeductionsTable = pgTable(
  "activity_monthly_deductions",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    settlementId: integer("settlement_id")
      .notNull()
      .references(() => activityMonthlySettlementsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    papRecordId: integer("pap_record_id").references(() => papRecordsTable.id, {
      onDelete: "set null",
    }),
    amount: doublePrecision("amount").notNull(),
    totalPapBefore: doublePrecision("total_pap_before").notNull(),
    totalPapAfter: doublePrecision("total_pap_after").notNull(),
    redeemablePapBefore: doublePrecision("redeemable_pap_before").notNull(),
    redeemablePapAfter: doublePrecision("redeemable_pap_after").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("activity_monthly_deductions_settlement_user_unique").on(
      table.settlementId,
      table.userId,
    ),
    foreignKey({
      columns: [table.corporationId, table.settlementId],
      foreignColumns: [
        activityMonthlySettlementsTable.corporationId,
        activityMonthlySettlementsTable.id,
      ],
      name: "activity_monthly_deductions_corporation_settlement_fk",
    }).onDelete("cascade"),
  ],
);

export type ActivityMonthlySettlement = typeof activityMonthlySettlementsTable.$inferSelect;
export type ActivityMonthlyDeduction = typeof activityMonthlyDeductionsTable.$inferSelect;
