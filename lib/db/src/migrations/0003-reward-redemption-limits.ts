import type { PoolClient } from "pg";

export const rewardRedemptionLimitsMigration = {
  id: "0003_reward_redemption_limits",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "rewards"
      ADD COLUMN IF NOT EXISTS "max_redemptions_per_user" integer;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'rewards_max_redemptions_per_user_positive'
            AND conrelid = 'rewards'::regclass
        ) THEN
          ALTER TABLE "rewards"
          ADD CONSTRAINT "rewards_max_redemptions_per_user_positive"
          CHECK ("max_redemptions_per_user" IS NULL OR "max_redemptions_per_user" > 0);
        END IF;
      END
      $$;
    `);
  },
};
