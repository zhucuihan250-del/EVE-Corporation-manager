import type { Pool, PoolClient } from "pg";
import { redemptionRewardNameSnapshotMigration } from "./0001-redemption-reward-name-snapshot";
import { limitedTimeRewardsMigration } from "./0002-limited-time-rewards";

type Migration = {
  id: string;
  up(client: PoolClient): Promise<void>;
};

const migrations: Migration[] = [redemptionRewardNameSnapshotMigration, limitedTimeRewardsMigration];

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1::integer, $2::integer)", [20260720, 1]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS "app_migrations" (
        "id" text PRIMARY KEY,
        "applied_at" timestamp with time zone NOT NULL DEFAULT now()
      );
    `);

    for (const migration of migrations) {
      const applied = await client.query('SELECT 1 FROM "app_migrations" WHERE "id" = $1', [migration.id]);

      if (applied.rowCount) {
        continue;
      }

      await migration.up(client);
      await client.query('INSERT INTO "app_migrations" ("id") VALUES ($1)', [migration.id]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
