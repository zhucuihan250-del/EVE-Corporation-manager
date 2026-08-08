import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export const corporationRosterConnectionsTable = pgTable(
  "corporation_roster_connections",
  {
    corporationId: integer("corporation_id")
      .primaryKey()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    characterId: integer("character_id").notNull(),
    connectedBy: integer("connected_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "restrict" }),
    accessToken: text("access_token").notNull(),
    refreshToken: text("refresh_token").notNull(),
    tokenExpiry: timestamp("token_expiry", { withTimezone: true }).notNull(),
    status: text("status", { enum: ["connected", "error"] })
      .notNull()
      .default("connected"),
    lastError: text("last_error"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);
