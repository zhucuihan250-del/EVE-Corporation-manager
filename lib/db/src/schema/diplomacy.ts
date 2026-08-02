import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export const diplomacyCasesTable = pgTable("diplomacy_cases", {
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
  internalNotes: text("internal_notes"),
  assignedTo: integer("assigned_to").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type DiplomacyCase = typeof diplomacyCasesTable.$inferSelect;
