import { pgTable, text, serial, timestamp, integer, boolean, uniqueIndex } from "drizzle-orm/pg-core";
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
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  retainedUntil: timestamp("retained_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex("characters_corporation_id_unique").on(table.corporationId, table.id),
]);

export const insertCharacterSchema = createInsertSchema(charactersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCharacter = z.infer<typeof insertCharacterSchema>;
export type Character = typeof charactersTable.$inferSelect;
