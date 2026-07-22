import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { charactersTable } from "./characters";
import { fleetsTable } from "./fleets";
import { usersTable } from "./users";

export const battleReportsTable = pgTable("battle_reports", {
  id: serial("id").primaryKey(),
  fleetId: integer("fleet_id")
    .unique()
    .references(() => fleetsTable.id, { onDelete: "set null" }),
  fleetName: text("fleet_name").notNull(),
  fleetCommander: text("fleet_commander").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  status: text("status", {
    enum: ["pending", "generating", "ready", "partial", "failed"],
  })
    .notNull()
    .default("pending"),
  errorMessage: text("error_message"),
  totalDestroyed: doublePrecision("total_destroyed").notNull().default(0),
  totalLost: doublePrecision("total_lost").notNull().default(0),
  damageDealt: doublePrecision("damage_dealt").notNull().default(0),
  killmailCount: integer("killmail_count").notNull().default(0),
  friendlyLosses: integer("friendly_losses").notNull().default(0),
  hostileLosses: integer("hostile_losses").notNull().default(0),
  primarySystemId: integer("primary_system_id"),
  primarySystemName: text("primary_system_name"),
  generatedAt: timestamp("generated_at", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const battleReportParticipantsTable = pgTable(
  "battle_report_participants",
  {
    id: serial("id").primaryKey(),
    battleReportId: integer("battle_report_id")
      .notNull()
      .references(() => battleReportsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    characterId: integer("character_id").references(() => charactersTable.id, {
      onDelete: "set null",
    }),
    eveCharacterId: integer("eve_character_id").notNull(),
    characterName: text("character_name").notNull(),
    corporationId: integer("corporation_id"),
    corporationName: text("corporation_name"),
    primaryShipTypeId: integer("primary_ship_type_id"),
    primaryShipName: text("primary_ship_name"),
    damageDealt: doublePrecision("damage_dealt").notNull().default(0),
    killsInvolved: integer("kills_involved").notNull().default(0),
    finalBlows: integer("final_blows").notNull().default(0),
    losses: integer("losses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("battle_report_participants_report_character_unique").on(
      table.battleReportId,
      table.eveCharacterId,
    ),
  ],
);

export type BattleReportAttacker = {
  characterId: number | null;
  characterName: string | null;
  corporationId: number | null;
  corporationName: string | null;
  allianceId: number | null;
  allianceName: string | null;
  shipTypeId: number | null;
  shipName: string | null;
  damageDone: number;
  finalBlow: boolean;
  isFleetMember: boolean;
};

export const battleReportKillmailsTable = pgTable(
  "battle_report_killmails",
  {
    id: serial("id").primaryKey(),
    battleReportId: integer("battle_report_id")
      .notNull()
      .references(() => battleReportsTable.id, { onDelete: "cascade" }),
    killmailId: integer("killmail_id").notNull(),
    killmailHash: text("killmail_hash").notNull(),
    killmailTime: timestamp("killmail_time", { withTimezone: true }).notNull(),
    solarSystemId: integer("solar_system_id").notNull(),
    solarSystemName: text("solar_system_name"),
    victimCharacterId: integer("victim_character_id"),
    victimCharacterName: text("victim_character_name"),
    victimCorporationId: integer("victim_corporation_id"),
    victimCorporationName: text("victim_corporation_name"),
    victimAllianceId: integer("victim_alliance_id"),
    victimAllianceName: text("victim_alliance_name"),
    victimShipTypeId: integer("victim_ship_type_id").notNull(),
    victimShipName: text("victim_ship_name"),
    victimIsFleetMember: boolean("victim_is_fleet_member")
      .notNull()
      .default(false),
    totalValue: doublePrecision("total_value").notNull().default(0),
    damageTaken: integer("damage_taken").notNull().default(0),
    friendlyDamage: integer("friendly_damage").notNull().default(0),
    friendlyAttackers: integer("friendly_attackers").notNull().default(0),
    finalBlowByFleet: boolean("final_blow_by_fleet").notNull().default(false),
    attackers: jsonb("attackers")
      .$type<BattleReportAttacker[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    zkillboardUrl: text("zkillboard_url"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("battle_report_killmails_report_killmail_unique").on(
      table.battleReportId,
      table.killmailId,
    ),
  ],
);

export type BattleReviewManualNode = {
  id: string;
  category: "key_ship" | "key_kill" | "loss_peak" | "phase" | "note";
  occurredAt: string;
  title: string;
  description: string;
};

export type BattleReplayKeyEvent = {
  killmailId: number;
  occurredAt: string;
  title: string;
  reason: string;
  confidence: number;
  shipName: string | null;
  pilotName: string | null;
  friendlyLoss: boolean;
  totalValue: number;
};

export type BattleReplayLossPeak = {
  startedAt: string;
  endedAt: string;
  title: string;
  reason: string;
  confidence: number;
  killmailIds: number[];
  friendlyLosses: number;
  hostileLosses: number;
  totalValue: number;
};

export type BattleReplaySuggestion = {
  category:
    | "target_calling"
    | "logistics"
    | "positioning"
    | "extraction"
    | "fleet_composition"
    | "tempo"
    | "other";
  title: string;
  observation: string;
  evidence: string;
  recommendation: string;
  confidence: number;
  relatedKillmailIds: number[];
};

export type BattleReplayAnalysis = {
  version: 1;
  source: "openai" | "rules";
  model: string;
  generatedAt: string;
  summary: string;
  keyShips: BattleReplayKeyEvent[];
  keyKills: BattleReplayKeyEvent[];
  lossPeaks: BattleReplayLossPeak[];
  suggestions: BattleReplaySuggestion[];
};

export const battleReportReviewsTable = pgTable("battle_report_reviews", {
  id: serial("id").primaryKey(),
  battleReportId: integer("battle_report_id")
    .notNull()
    .unique()
    .references(() => battleReportsTable.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["draft", "published"] })
    .notNull()
    .default("draft"),
  aiStatus: text("ai_status", {
    enum: ["not_started", "generating", "ready", "failed"],
  })
    .notNull()
    .default("not_started"),
  aiSource: text("ai_source", { enum: ["openai", "rules"] }),
  aiModel: text("ai_model"),
  aiError: text("ai_error"),
  aiAnalysis: jsonb("ai_analysis").$type<BattleReplayAnalysis | null>(),
  manualNodes: jsonb("manual_nodes")
    .$type<BattleReviewManualNode[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  conclusion: text("conclusion").notNull().default(""),
  updatedBy: integer("updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  aiAnalyzedAt: timestamp("ai_analyzed_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type BattleReport = typeof battleReportsTable.$inferSelect;
export type BattleReportParticipant =
  typeof battleReportParticipantsTable.$inferSelect;
export type BattleReportKillmail =
  typeof battleReportKillmailsTable.$inferSelect;
export type BattleReportReview = typeof battleReportReviewsTable.$inferSelect;
