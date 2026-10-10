import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex, check, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { corporationsTable } from "./corporations";

export const charactersTable = pgTable("characters", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => usersTable.id, { onDelete: "cascade" }),
  eveCharacterId: integer("eve_character_id").notNull(),
  eveCharacterName: text("eve_character_name").notNull(),
  corporationId: integer("corporation_id").references(() => corporationsTable.id, { onDelete: "set null" }),
  corporationName: text("corporation_name"),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry", { withTimezone: true }),
  isMain: boolean("is_main").notNull().default(false),
  membershipStatus: text("membership_status", { enum: ["unknown", "member", "departed"] }).notNull().default("unknown"),
  membershipCheckedAt: timestamp("membership_checked_at", { withTimezone: true }),
  corporationLeftAt: timestamp("corporation_left_at", { withTimezone: true }),
  actualCorporationId: integer("actual_corporation_id"),
  retentionCorporationId: integer("retention_corporation_id").references(() => corporationsTable.id, { onDelete: "restrict" }),
  membershipRetainedUntil: timestamp("membership_retained_until", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  retainedUntil: timestamp("retained_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("characters_corporation_id_unique").on(table.corporationId, table.id),
  check("characters_membership_status_valid", sql`${table.membershipStatus} IN ('unknown', 'member', 'departed')`),
  index("characters_membership_retention_due_idx")
    .on(table.retentionCorporationId, table.membershipRetainedUntil, table.id)
    .where(sql`${table.membershipStatus} = 'departed' AND ${table.membershipRetainedUntil} IS NOT NULL`),
]);

export const insertCharacterSchema = createInsertSchema(charactersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCharacter = z.infer<typeof insertCharacterSchema>;
export type Character = typeof charactersTable.$inferSelect;
