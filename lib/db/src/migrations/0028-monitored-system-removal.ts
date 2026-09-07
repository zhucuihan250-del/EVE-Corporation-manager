import type { PoolClient } from "pg";

export const monitoredSystemRemovalMigration = {
  id: "0028_monitored_system_removal",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "monitored_systems"
        ADD COLUMN IF NOT EXISTS "removed_at" timestamptz;

      CREATE INDEX IF NOT EXISTS "monitored_systems_corporation_removed_idx"
        ON "monitored_systems" ("corporation_id", "removed_at");
    `);
  },
};
