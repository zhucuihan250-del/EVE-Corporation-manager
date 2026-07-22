import type { PoolClient } from "pg";

export const fleetBattleReportsMigration = {
  id: "0004_fleet_battle_reports",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "battle_reports" (
        "id" serial PRIMARY KEY,
        "fleet_id" integer UNIQUE REFERENCES "fleets"("id") ON DELETE SET NULL,
        "fleet_name" text NOT NULL,
        "fleet_commander" text NOT NULL,
        "started_at" timestamp with time zone NOT NULL,
        "ended_at" timestamp with time zone NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "error_message" text,
        "total_destroyed" double precision NOT NULL DEFAULT 0,
        "total_lost" double precision NOT NULL DEFAULT 0,
        "damage_dealt" double precision NOT NULL DEFAULT 0,
        "killmail_count" integer NOT NULL DEFAULT 0,
        "friendly_losses" integer NOT NULL DEFAULT 0,
        "hostile_losses" integer NOT NULL DEFAULT 0,
        "primary_system_id" integer,
        "primary_system_name" text,
        "generated_at" timestamp with time zone,
        "last_synced_at" timestamp with time zone,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "battle_reports_status_valid"
          CHECK ("status" IN ('pending', 'generating', 'ready', 'partial', 'failed'))
      );
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "battle_report_participants" (
        "id" serial PRIMARY KEY,
        "battle_report_id" integer NOT NULL REFERENCES "battle_reports"("id") ON DELETE CASCADE,
        "user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "character_id" integer REFERENCES "characters"("id") ON DELETE SET NULL,
        "eve_character_id" integer NOT NULL,
        "character_name" text NOT NULL,
        "corporation_id" integer,
        "corporation_name" text,
        "primary_ship_type_id" integer,
        "primary_ship_name" text,
        "damage_dealt" double precision NOT NULL DEFAULT 0,
        "kills_involved" integer NOT NULL DEFAULT 0,
        "final_blows" integer NOT NULL DEFAULT 0,
        "losses" integer NOT NULL DEFAULT 0,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "battle_report_participants_report_character_unique"
        ON "battle_report_participants" ("battle_report_id", "eve_character_id");
      CREATE INDEX IF NOT EXISTS "battle_report_participants_report_idx"
        ON "battle_report_participants" ("battle_report_id");
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS "battle_report_killmails" (
        "id" serial PRIMARY KEY,
        "battle_report_id" integer NOT NULL REFERENCES "battle_reports"("id") ON DELETE CASCADE,
        "killmail_id" integer NOT NULL,
        "killmail_hash" text NOT NULL,
        "killmail_time" timestamp with time zone NOT NULL,
        "solar_system_id" integer NOT NULL,
        "solar_system_name" text,
        "victim_character_id" integer,
        "victim_character_name" text,
        "victim_corporation_id" integer,
        "victim_corporation_name" text,
        "victim_alliance_id" integer,
        "victim_alliance_name" text,
        "victim_ship_type_id" integer NOT NULL,
        "victim_ship_name" text,
        "victim_is_fleet_member" boolean NOT NULL DEFAULT false,
        "total_value" double precision NOT NULL DEFAULT 0,
        "damage_taken" integer NOT NULL DEFAULT 0,
        "friendly_damage" integer NOT NULL DEFAULT 0,
        "friendly_attackers" integer NOT NULL DEFAULT 0,
        "final_blow_by_fleet" boolean NOT NULL DEFAULT false,
        "zkillboard_url" text,
        "created_at" timestamp with time zone NOT NULL DEFAULT now()
      );

      CREATE UNIQUE INDEX IF NOT EXISTS "battle_report_killmails_report_killmail_unique"
        ON "battle_report_killmails" ("battle_report_id", "killmail_id");
      CREATE INDEX IF NOT EXISTS "battle_report_killmails_report_time_idx"
        ON "battle_report_killmails" ("battle_report_id", "killmail_time");
    `);

    await client.query(`
      INSERT INTO "battle_reports" (
        "fleet_id", "fleet_name", "fleet_commander", "started_at", "ended_at", "status"
      )
      SELECT
        "id",
        "name",
        "fleet_commander",
        COALESCE("started_at", "created_at"),
        "ended_at",
        'pending'
      FROM "fleets"
      WHERE "is_active" = false
        AND "ended_at" IS NOT NULL
      ON CONFLICT ("fleet_id") DO NOTHING;
    `);

    await client.query(`
      INSERT INTO "battle_report_participants" (
        "battle_report_id",
        "user_id",
        "character_id",
        "eve_character_id",
        "character_name",
        "corporation_id",
        "corporation_name"
      )
      SELECT DISTINCT ON (br."id", c."eve_character_id")
        br."id",
        p."user_id",
        c."id",
        c."eve_character_id",
        c."eve_character_name",
        c."corporation_id",
        c."corporation_name"
      FROM "battle_reports" br
      JOIN "pap_records" p ON p."fleet_id" = br."fleet_id" AND p."type" = 'fleet'
      JOIN "characters" c ON c."id" = p."character_id"
      ORDER BY br."id", c."eve_character_id", p."created_at" ASC
      ON CONFLICT ("battle_report_id", "eve_character_id") DO NOTHING;
    `);
  },
};
