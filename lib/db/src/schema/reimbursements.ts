import {
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  index,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { fleetsTable } from "./fleets";
import { usersTable } from "./users";
import { identityGroupsTable } from "./identity_groups";

export type ReimbursementValidation = {
  killmailVerified: boolean;
  characterVerified: boolean;
  fleetVerified: boolean | null;
  checkedAt: string;
  message: string;
};

export const reimbursementClaimsTable = pgTable(
  "reimbursement_claims",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    submittedBy: integer("submitted_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    characterId: integer("character_id").notNull(),
    characterName: text("character_name").notNull(),
    fleetId: integer("fleet_id").references(() => fleetsTable.id, {
      onDelete: "restrict",
    }),
    identityGroupId: integer("identity_group_id").references(() => identityGroupsTable.id, {
      onDelete: "restrict",
    }),
    killmailId: integer("killmail_id").notNull(),
    killmailHash: text("killmail_hash").notNull(),
    killmailUrl: text("killmail_url").notNull(),
    lossOccurredAt: timestamp("loss_occurred_at", { withTimezone: true }).notNull(),
    shipTypeId: integer("ship_type_id").notNull(),
    shipName: text("ship_name").notNull(),
    lossValue: doublePrecision("loss_value").notNull().default(0),
    requestedAmount: doublePrecision("requested_amount").notNull(),
    approvedAmount: doublePrecision("approved_amount"),
    description: text("description").notNull(),
    validation: jsonb("validation").$type<ReimbursementValidation>().notNull(),
    status: text("status", {
      enum: ["submitted", "reviewing", "approved", "partially_approved", "rejected", "pending_payment", "paid"],
    })
      .notNull()
      .default("submitted"),
    reviewerNotes: text("reviewer_notes"),
    paymentReference: text("payment_reference"),
    reviewedBy: integer("reviewed_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("reimbursement_claims_corporation_killmail_unique").on(
      table.corporationId,
      table.killmailId,
    ),
    index("reimbursement_claims_corporation_identity_group_idx").on(
      table.corporationId,
      table.identityGroupId,
    ),
  ],
);

export type ReimbursementClaim = typeof reimbursementClaimsTable.$inferSelect;
