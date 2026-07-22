import type { PoolClient } from "pg";

export const battleReportAttackersMigration = {
  id: "0006_battle_report_attackers",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "battle_report_killmails"
        ADD COLUMN IF NOT EXISTS "attackers" jsonb NOT NULL DEFAULT '[]'::jsonb;
    `);
  },
};
