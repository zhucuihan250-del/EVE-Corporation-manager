import type { PoolClient } from "pg";

export const redemptionRewardNameSnapshotMigration = {
  id: "0001_redemption_reward_name_snapshot",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "redemptions"
      ADD COLUMN IF NOT EXISTS "reward_name" text;
    `);

    await client.query(`
      UPDATE "redemptions" AS redemption
      SET "reward_name" = reward."name"
      FROM "rewards" AS reward
      WHERE redemption."reward_id" = reward."id"
        AND redemption."reward_name" IS NULL;
    `);

    const unresolved = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM "redemptions"
      WHERE "reward_name" IS NULL;
    `);

    if (Number(unresolved.rows[0]?.count ?? 0) > 0) {
      throw new Error("Cannot snapshot redemption reward names because one or more rewards are missing");
    }

    await client.query(`
      ALTER TABLE "redemptions"
      ALTER COLUMN "reward_name" SET NOT NULL;
    `);
  },
};
