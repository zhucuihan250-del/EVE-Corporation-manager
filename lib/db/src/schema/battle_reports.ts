import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { charactersTable } from "./characters";
import { fleetsTable } from "./fleets";
import { usersTable } from "./users";

export const battleReportsTable = pgTable("battle_reports", {
  id: serial("id").primaryKey(),
  fleetId: integer("fleet_id").unique().references(() => fleetsTable.id, { onDelete: "set null" }),
  fleetName: text("fleet_name").notNull(),
  fleetCommander: text("fleet_commander").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  endedAt: timestamp("ended_at", { withTimezone: true }).notNull(),
  status: text("status", { enum: ["pending", "generating", "ready", "partial", "failed"] })
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const battleReportParticipantsTable = pgTable(
  "battle_report_participants",
  {
    id: serial("id").primaryKey(),
    battleReportId: integer("battle_report_id")
      .notNull()
      .references(() => battleReportsTable.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    characterId: integer("character_id").references(() => charactersTable.id, { onDelete: "set null" }),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("battle_report_participants_report_character_unique").on(
      table.battleReportId,
      table.eveCharacterId,
    ),
  ],
);

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
    victimIsFleetMember: boolean("victim_is_fleet_member").notNull().default(false),
    totalValue: doublePrecision("total_value").notNull().default(0),
    damageTaken: integer("damage_taken").notNull().default(0),
    friendlyDamage: integer("friendly_damage").notNull().default(0),
    friendlyAttackers: integer("friendly_attackers").notNull().default(0),
    finalBlowByFleet: boolean("final_blow_by_fleet").notNull().default(false),
    zkillboardUrl: text("zkillboard_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("battle_report_killmails_report_killmail_unique").on(
      table.battleReportId,
      table.killmailId,
    ),
  ],
);

export type BattleReport = typeof battleReportsTable.$inferSelect;
export type BattleReportParticipant = typeof battleReportParticipantsTable.$inferSelect;
export type BattleReportKillmail = typeof battleReportKillmailsTable.$inferSelect;
