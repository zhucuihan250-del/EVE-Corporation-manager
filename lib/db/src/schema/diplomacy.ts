import {
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export const diplomacyCasesTable = pgTable(
  "diplomacy_cases",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    submittedBy: integer("submitted_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    submitterCharacterId: integer("submitter_character_id").notNull(),
    submitterName: text("submitter_name").notNull(),
    category: text("category", {
      enum: ["standings", "conflict", "cooperation", "compensation", "complaint", "other"],
    }).notNull(),
    counterparty: text("counterparty").notNull(),
    subject: text("subject").notNull(),
    description: text("description").notNull(),
    evidenceUrl: text("evidence_url"),
    urgency: text("urgency", { enum: ["normal", "high", "urgent"] })
      .notNull()
      .default("normal"),
    status: text("status", {
      enum: ["submitted", "accepted", "investigating", "waiting", "resolved", "rejected", "closed"],
    })
      .notNull()
      .default("submitted"),
    publicReply: text("public_reply"),
    internalNotes: text("internal_notes"),
    assignedTo: integer("assigned_to").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    assignedName: text("assigned_name"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("diplomacy_cases_corporation_id_unique").on(
      table.corporationId,
      table.id,
    ),
    index("diplomacy_cases_corporation_status_idx").on(
      table.corporationId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const diplomacyCaseEventsTable = pgTable(
  "diplomacy_case_events",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    caseId: integer("case_id").notNull(),
    actorUserId: integer("actor_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    actorName: text("actor_name").notNull(),
    eventType: text("event_type", {
      enum: [
        "submitted",
        "assigned",
        "unassigned",
        "status_changed",
        "public_reply",
        "internal_note",
      ],
    }).notNull(),
    visibility: text("visibility", { enum: ["public", "internal"] })
      .notNull()
      .default("public"),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    message: text("message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "diplomacy_case_events_corporation_case_fk",
      columns: [table.corporationId, table.caseId],
      foreignColumns: [
        diplomacyCasesTable.corporationId,
        diplomacyCasesTable.id,
      ],
    }).onDelete("cascade"),
    index("diplomacy_case_events_corporation_case_time_idx").on(
      table.corporationId,
      table.caseId,
      table.createdAt,
    ),
  ],
);

export type DiplomacyCase = typeof diplomacyCasesTable.$inferSelect;
export type DiplomacyCaseEvent = typeof diplomacyCaseEventsTable.$inferSelect;
