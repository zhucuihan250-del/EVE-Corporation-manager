import type { PoolClient } from "pg";

export const systemMonitoringMigration = {
  id: "0026_system_monitoring",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE "monitored_systems" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "solar_system_id" integer NOT NULL,
        "solar_system_name" text NOT NULL,
        "is_active" boolean NOT NULL DEFAULT true,
        "burst_window_minutes" integer NOT NULL DEFAULT 10 CHECK ("burst_window_minutes" BETWEEN 1 AND 60),
        "burst_threshold" integer NOT NULL DEFAULT 3 CHECK ("burst_threshold" BETWEEN 2 AND 50),
        "high_value_threshold" double precision NOT NULL DEFAULT 1000000000 CHECK ("high_value_threshold" >= 0),
        "activity_multiplier" double precision NOT NULL DEFAULT 1.5 CHECK ("activity_multiplier" BETWEEN 1 AND 20),
        "notes" text,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "monitored_systems_corporation_system_unique"
        ON "monitored_systems" ("corporation_id", "solar_system_id");
      CREATE UNIQUE INDEX "monitored_systems_corporation_id_unique"
        ON "monitored_systems" ("corporation_id", "id");
      CREATE INDEX "monitored_systems_corporation_active_idx"
        ON "monitored_systems" ("corporation_id", "is_active");

      CREATE TABLE "intel_bridge_pairings" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "created_by" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "code_hash" text NOT NULL UNIQUE,
        "expires_at" timestamptz NOT NULL,
        "used_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "intel_bridge_pairings_corporation_expiry_idx"
        ON "intel_bridge_pairings" ("corporation_id", "expires_at");

      CREATE TABLE "intel_bridges" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "owner_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "name" text NOT NULL,
        "device_platform" text,
        "token_hash" text NOT NULL UNIQUE,
        "channel_names" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "last_seen_at" timestamptz,
        "last_error" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "intel_bridges_corporation_id_unique"
        ON "intel_bridges" ("corporation_id", "id");
      CREATE INDEX "intel_bridges_corporation_active_idx"
        ON "intel_bridges" ("corporation_id", "is_active");

      CREATE TABLE "system_intel_events" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "monitor_id" integer NOT NULL,
        "relay_bridge_id" integer,
        "reporter_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "reporter_character_name" text,
        "source" text NOT NULL CHECK ("source" IN ('chat', 'manual', 'killmail', 'activity')),
        "event_type" text NOT NULL CHECK ("event_type" IN ('hostile_report', 'player_kill', 'corporation_loss', 'kill_burst', 'special_ship', 'high_value', 'activity_spike')),
        "severity" text NOT NULL CHECK ("severity" IN ('info', 'warning', 'danger', 'critical')),
        "confidence" text NOT NULL CHECK ("confidence" IN ('unconfirmed', 'reported', 'confirmed')),
        "solar_system_id" integer NOT NULL,
        "solar_system_name" text NOT NULL,
        "summary" text NOT NULL,
        "raw_message" text,
        "enemy_count" integer,
        "ship_tags" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "direction" text,
        "killmail_id" integer,
        "zkillboard_url" text,
        "total_value" double precision,
        "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "occurred_at" timestamptz NOT NULL,
        "received_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz,
        "dedupe_key" text NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "system_intel_events_monitor_corporation_fk"
          FOREIGN KEY ("corporation_id", "monitor_id")
          REFERENCES "monitored_systems"("corporation_id", "id") ON DELETE RESTRICT,
        CONSTRAINT "system_intel_events_bridge_corporation_fk"
          FOREIGN KEY ("corporation_id", "relay_bridge_id")
          REFERENCES "intel_bridges"("corporation_id", "id") ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX "system_intel_events_corporation_dedupe_unique"
        ON "system_intel_events" ("corporation_id", "dedupe_key");
      CREATE INDEX "system_intel_events_corporation_time_idx"
        ON "system_intel_events" ("corporation_id", "occurred_at" DESC);
      CREATE INDEX "system_intel_events_monitor_time_idx"
        ON "system_intel_events" ("monitor_id", "occurred_at" DESC);

      CREATE TABLE "system_activity_samples" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "monitor_id" integer NOT NULL,
        "solar_system_id" integer NOT NULL,
        "sampled_at" timestamptz NOT NULL,
        "jumps" integer NOT NULL DEFAULT 0,
        "ship_kills" integer NOT NULL DEFAULT 0,
        "pod_kills" integer NOT NULL DEFAULT 0,
        "npc_kills" integer NOT NULL DEFAULT 0,
        "jump_baseline" double precision,
        "kill_baseline" double precision,
        "is_anomalous" boolean NOT NULL DEFAULT false,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "system_activity_samples_monitor_corporation_fk"
          FOREIGN KEY ("corporation_id", "monitor_id")
          REFERENCES "monitored_systems"("corporation_id", "id") ON DELETE RESTRICT
      );
      CREATE UNIQUE INDEX "system_activity_samples_monitor_hour_unique"
        ON "system_activity_samples" ("monitor_id", "sampled_at");
      CREATE INDEX "system_activity_samples_corporation_time_idx"
        ON "system_activity_samples" ("corporation_id", "sampled_at" DESC);

      CREATE TABLE "system_monitor_feed_state" (
        "feed" text PRIMARY KEY,
        "next_sequence" bigint NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
  },
};
