import type { PoolClient } from "pg";

export const corporationRosterAuditMigration = {
  id: "0012_corporation_roster_audit",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE "corporation_roster_connections" (
        "corporation_id" integer PRIMARY KEY REFERENCES "corporations"("id") ON DELETE CASCADE,
        "character_id" integer NOT NULL,
        "connected_by" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "access_token" text NOT NULL,
        "refresh_token" text NOT NULL,
        "token_expiry" timestamptz NOT NULL,
        "status" text NOT NULL DEFAULT 'connected'
          CHECK ("status" IN ('connected', 'error')),
        "last_error" text,
        "last_synced_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
    `);
  },
};
