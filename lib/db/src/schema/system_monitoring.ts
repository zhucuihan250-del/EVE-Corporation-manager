import {
  boolean,
  bigint,
  doublePrecision,
  foreignKey,
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

export const monitoredSystemsTable = pgTable(
  "monitored_systems",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    solarSystemId: integer("solar_system_id").notNull(),
    solarSystemName: text("solar_system_name").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    burstWindowMinutes: integer("burst_window_minutes").notNull().default(10),
    burstThreshold: integer("burst_threshold").notNull().default(3),
    highValueThreshold: doublePrecision("high_value_threshold")
      .notNull()
      .default(1_000_000_000),
    activityMultiplier: doublePrecision("activity_multiplier")
      .notNull()
      .default(1.5),
    notes: text("notes"),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("monitored_systems_corporation_system_unique").on(
      table.corporationId,
      table.solarSystemId,
    ),
    uniqueIndex("monitored_systems_corporation_id_unique").on(
      table.corporationId,
      table.id,
    ),
    index("monitored_systems_corporation_active_idx").on(
      table.corporationId,
      table.isActive,
    ),
    index("monitored_systems_corporation_removed_idx").on(
      table.corporationId,
      table.removedAt,
    ),
  ],
);

export const intelBridgePairingsTable = pgTable(
  "intel_bridge_pairings",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    createdBy: integer("created_by")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("intel_bridge_pairings_code_hash_unique").on(table.codeHash),
    index("intel_bridge_pairings_corporation_expiry_idx").on(
      table.corporationId,
      table.expiresAt,
    ),
  ],
);

export const intelBridgesTable = pgTable(
  "intel_bridges",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    ownerUserId: integer("owner_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    devicePlatform: text("device_platform"),
    tokenHash: text("token_hash").notNull(),
    channelNames: jsonb("channel_names")
      .$type<string[]>()
      .notNull()
      .default([]),
    isActive: boolean("is_active").notNull().default(true),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (table) => [
    uniqueIndex("intel_bridges_token_hash_unique").on(table.tokenHash),
    uniqueIndex("intel_bridges_corporation_id_unique").on(
      table.corporationId,
      table.id,
    ),
    index("intel_bridges_corporation_active_idx").on(
      table.corporationId,
      table.isActive,
    ),
  ],
);

export type SystemIntelMetadata = {
  sourceEventId?: string;
  victimCharacterId?: number | null;
  victimCorporationId?: number | null;
  victimShipTypeId?: number | null;
  victimShipName?: string | null;
  capital?: boolean;
  blackOps?: boolean;
  interdictor?: boolean;
  friendlyLoss?: boolean;
  channelName?: string;
  relayCount?: number;
};

export const systemIntelEventsTable = pgTable(
  "system_intel_events",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    monitorId: integer("monitor_id").notNull(),
    relayBridgeId: integer("relay_bridge_id"),
    reporterUserId: integer("reporter_user_id").references(
      () => usersTable.id,
      {
        onDelete: "set null",
      },
    ),
    reporterCharacterName: text("reporter_character_name"),
    source: text("source", {
      enum: ["chat", "manual", "killmail", "activity"],
    }).notNull(),
    eventType: text("event_type", {
      enum: [
        "hostile_report",
        "player_kill",
        "corporation_loss",
        "kill_burst",
        "special_ship",
        "high_value",
        "activity_spike",
      ],
    }).notNull(),
    severity: text("severity", {
      enum: ["info", "warning", "danger", "critical"],
    }).notNull(),
    confidence: text("confidence", {
      enum: ["unconfirmed", "reported", "confirmed"],
    }).notNull(),
    solarSystemId: integer("solar_system_id").notNull(),
    solarSystemName: text("solar_system_name").notNull(),
    summary: text("summary").notNull(),
    rawMessage: text("raw_message"),
    enemyCount: integer("enemy_count"),
    shipTags: jsonb("ship_tags").$type<string[]>().notNull().default([]),
    direction: text("direction"),
    killmailId: integer("killmail_id"),
    zkillboardUrl: text("zkillboard_url"),
    totalValue: doublePrecision("total_value"),
    metadata: jsonb("metadata")
      .$type<SystemIntelMetadata>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "system_intel_events_monitor_corporation_fk",
      columns: [table.corporationId, table.monitorId],
      foreignColumns: [
        monitoredSystemsTable.corporationId,
        monitoredSystemsTable.id,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "system_intel_events_bridge_corporation_fk",
      columns: [table.corporationId, table.relayBridgeId],
      foreignColumns: [intelBridgesTable.corporationId, intelBridgesTable.id],
    }).onDelete("restrict"),
    uniqueIndex("system_intel_events_corporation_dedupe_unique").on(
      table.corporationId,
      table.dedupeKey,
    ),
    index("system_intel_events_corporation_time_idx").on(
      table.corporationId,
      table.occurredAt,
    ),
    index("system_intel_events_monitor_time_idx").on(
      table.monitorId,
      table.occurredAt,
    ),
  ],
);

export const systemActivitySamplesTable = pgTable(
  "system_activity_samples",
  {
    id: serial("id").primaryKey(),
    corporationId: integer("corporation_id")
      .notNull()
      .references(() => corporationsTable.id, { onDelete: "cascade" }),
    monitorId: integer("monitor_id").notNull(),
    solarSystemId: integer("solar_system_id").notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull(),
    jumps: integer("jumps").notNull().default(0),
    shipKills: integer("ship_kills").notNull().default(0),
    podKills: integer("pod_kills").notNull().default(0),
    npcKills: integer("npc_kills").notNull().default(0),
    jumpBaseline: doublePrecision("jump_baseline"),
    killBaseline: doublePrecision("kill_baseline"),
    isAnomalous: boolean("is_anomalous").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      name: "system_activity_samples_monitor_corporation_fk",
      columns: [table.corporationId, table.monitorId],
      foreignColumns: [
        monitoredSystemsTable.corporationId,
        monitoredSystemsTable.id,
      ],
    }).onDelete("restrict"),
    uniqueIndex("system_activity_samples_monitor_hour_unique").on(
      table.monitorId,
      table.sampledAt,
    ),
    index("system_activity_samples_corporation_time_idx").on(
      table.corporationId,
      table.sampledAt,
    ),
  ],
);

export const systemMonitorFeedStateTable = pgTable(
  "system_monitor_feed_state",
  {
    feed: text("feed").primaryKey(),
    nextSequence: bigint("next_sequence", { mode: "number" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
);

export type MonitoredSystem = typeof monitoredSystemsTable.$inferSelect;
export type IntelBridge = typeof intelBridgesTable.$inferSelect;
export type SystemIntelEvent = typeof systemIntelEventsTable.$inferSelect;
export type SystemActivitySample =
  typeof systemActivitySamplesTable.$inferSelect;
