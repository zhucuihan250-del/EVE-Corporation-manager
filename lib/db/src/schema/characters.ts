import { pgTable, text, serial, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";

export const charactersTable = pgTable("characters", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => usersTable.id, { onDelete: "cascade" }),
  eveCharacterId: integer("eve_character_id").notNull(),
  eveCharacterName: text("eve_character_name").notNull(),
  corporationId: integer("corporation_id"),
  corporationName: text("corporation_name"),
  isMain: boolean("is_main").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCharacterSchema = createInsertSchema(charactersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertCharacter = z.infer<typeof insertCharacterSchema>;
export type Character = typeof charactersTable.$inferSelect;
