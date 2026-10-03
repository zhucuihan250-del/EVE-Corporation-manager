import { sql } from "drizzle-orm";
import { check, index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

/** Saved simulation inputs, not live EVE fittings. The API validates the
 * canonical payload and calculates the snapshot before writing either JSON. */
export const fittingsTable = pgTable("fittings", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id").notNull().references(() => corporationsTable.id, { onDelete: "cascade" }),
  visibility: text("visibility", { enum: ["personal", "corporation"] }).notNull(),
  ownerUserId: integer("owner_user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  createdBy: integer("created_by").references(() => usersTable.id, { onDelete: "set null" }),
  updatedBy: integer("updated_by").references(() => usersTable.id, { onDelete: "set null" }),
  authorName: text("author_name").notNull(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  fit: jsonb("fit").$type<Record<string, unknown>>().notNull(),
  simulation: jsonb("simulation").$type<Record<string, unknown>>().notNull(),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index("fittings_corporation_visibility_owner_id_idx").on(table.corporationId, table.visibility, table.ownerUserId, table.id),
  check("fittings_visibility_owner_check", sql`(${table.visibility} = 'personal' AND ${table.ownerUserId} IS NOT NULL) OR (${table.visibility} = 'corporation' AND ${table.ownerUserId} IS NULL)`),
  check("fittings_version_check", sql`${table.version} >= 1`),
  check("fittings_text_lengths_check", sql`char_length(${table.name}) BETWEEN 1 AND 100 AND char_length(${table.description}) <= 2000 AND char_length(${table.authorName}) BETWEEN 1 AND 200`),
  check("fittings_payload_check", sql`jsonb_typeof(${table.fit}) = 'object' AND coalesce(${table.fit}->>'schemaVersion' = '2', false) AND jsonb_typeof(${table.simulation}) = 'object'`),
]);
export type SavedFitting = typeof fittingsTable.$inferSelect;
