import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { corporationsTable } from "./corporations";
import { usersTable } from "./users";

export type CorporationStructureService = {
  name: string;
  state: "online" | "offline" | "cleanup";
};

export const corporationStructureConnectionsTable = pgTable(
  "corporation_structure_connections",
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

export const corporationStructuresTable = pgTable(
  "corporation_structures",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    structureId: text("structure_id").notNull(),
    name: text("name").notNull(),
    typeId: integer("type_id").notNull(),
    typeName: text("type_name").notNull(),
    systemId: integer("system_id").notNull(),
    systemName: text("system_name").notNull(),
    state: text("state").notNull(),
    fuelExpiresAt: timestamp("fuel_expires_at", { withTimezone: true }),
    stateTimerStart: timestamp("state_timer_start", { withTimezone: true }),
    stateTimerEnd: timestamp("state_timer_end", { withTimezone: true }),
    unanchorsAt: timestamp("unanchors_at", { withTimezone: true }),
    services: jsonb("services").$type<CorporationStructureService[]>().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("corporation_structures_corporation_structure_unique").on(
      table.corporationId,
      table.structureId,
    ),
    index("corporation_structures_corporation_active_idx").on(
      table.corporationId,
      table.isActive,
    ),
    index("corporation_structures_fuel_expiry_idx").on(
      table.corporationId,
      table.fuelExpiresAt,
    ),
  ],
);

export type CorporationStructure = typeof corporationStructuresTable.$inferSelect;
