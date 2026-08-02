import {
  doublePrecision,
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

export const corporationWalletConnectionsTable = pgTable(
  "corporation_wallet_connections",
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

export const corporationWalletEntriesTable = pgTable(
  "corporation_wallet_entries",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    division: integer("division").notNull(),
    refId: text("ref_id").notNull(),
    refType: text("ref_type").notNull(),
    amount: doublePrecision("amount").notNull(),
    balance: doublePrecision("balance"),
    firstPartyId: text("first_party_id"),
    secondPartyId: text("second_party_id"),
    reason: text("reason"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("corporation_wallet_entries_corporation_division_ref_unique").on(
      table.corporationId,
      table.division,
      table.refId,
    ),
  ],
);

export const corporationWalletBalancesTable = pgTable(
  "corporation_wallet_balances",
  {
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    division: integer("division").notNull(),
    balance: doublePrecision("balance").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("corporation_wallet_balances_corporation_division_unique").on(
      table.corporationId,
      table.division,
    ),
  ],
);

export const economyAnalysesTable = pgTable("economy_analyses", {
  id: serial("id").primaryKey(),
  corporationId: integer("corporation_id")
    .notNull()
    .references(() => corporationsTable.id, { onDelete: "cascade" }),
  periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
  periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
  source: text("source", { enum: ["openai", "rules"] }).notNull(),
  model: text("model").notNull(),
  analysis: jsonb("analysis").$type<Record<string, unknown>>().notNull(),
  createdBy: integer("created_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
