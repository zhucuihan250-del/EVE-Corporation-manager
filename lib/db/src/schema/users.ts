import { pgTable, text, serial, timestamp, integer, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const usersTable = pgTable("users", {
  id: serial("id").primaryKey(),
  eveCharacterId: integer("eve_character_id"),
  eveCharacterName: text("eve_character_name"),
  corporationId: integer("corporation_id"),
  corporationName: text("corporation_name"),
  corporationJoinedAt: timestamp("corporation_joined_at", { withTimezone: true }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiry: timestamp("token_expiry", { withTimezone: true }),
  role: text("role", { enum: ["member", "fc", "admin", "controller"] }).notNull().default("member"),
  totalPap: real("total_pap").notNull().default(0),
  redeemablePap: real("redeemable_pap").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
