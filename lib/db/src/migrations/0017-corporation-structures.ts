import type { PoolClient } from "pg";

export const corporationStructuresMigration = {
  id: "0017_corporation_structures",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "corporations"
        ADD COLUMN "structures_enabled" boolean NOT NULL DEFAULT false;
      UPDATE "corporations" SET "structures_enabled" = true WHERE "is_primary" = true;

      CREATE TABLE "corporation_structure_connections" (
        "corporation_id" integer PRIMARY KEY REFERENCES "corporations"("id") ON DELETE CASCADE,
        "character_id" integer NOT NULL,
        "connected_by" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "access_token" text NOT NULL,
        "refresh_token" text NOT NULL,
        "token_expiry" timestamptz NOT NULL,
        "status" text NOT NULL DEFAULT 'connected' CHECK ("status" IN ('connected', 'error')),
        "last_error" text,
        "last_synced_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE "corporation_structures" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "structure_id" text NOT NULL,
        "name" text NOT NULL,
        "type_id" integer NOT NULL,
        "type_name" text NOT NULL,
        "system_id" integer NOT NULL,
        "system_name" text NOT NULL,
        "state" text NOT NULL,
        "fuel_expires_at" timestamptz,
        "state_timer_start" timestamptz,
        "state_timer_end" timestamptz,
        "unanchors_at" timestamptz,
        "services" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "last_seen_at" timestamptz NOT NULL DEFAULT now(),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "corporation_structures_corporation_structure_unique"
        ON "corporation_structures" ("corporation_id", "structure_id");
      CREATE INDEX "corporation_structures_corporation_active_idx"
        ON "corporation_structures" ("corporation_id", "is_active");
      CREATE INDEX "corporation_structures_fuel_expiry_idx"
        ON "corporation_structures" ("corporation_id", "fuel_expires_at");
    `);
  },
};
