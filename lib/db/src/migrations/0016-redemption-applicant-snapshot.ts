import type { PoolClient } from "pg";

export const redemptionApplicantSnapshotMigration = {
  id: "0016_redemption_applicant_snapshot",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "redemptions"
        ADD COLUMN IF NOT EXISTS "applicant_character_id" integer,
        ADD COLUMN IF NOT EXISTS "applicant_character_name" text;
    `);
  },
};
