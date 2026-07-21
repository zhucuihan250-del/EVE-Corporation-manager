import type { PoolClient } from "pg";

export const limitedTimeRewardsMigration = {
  id: "0002_limited_time_rewards",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "rewards"
      ADD COLUMN IF NOT EXISTS "eligibility_months" integer;

      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "corporation_joined_at" timestamp with time zone;
    `);

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint
          WHERE conname = 'rewards_eligibility_months_positive'
            AND conrelid = 'rewards'::regclass
        ) THEN
          ALTER TABLE "rewards"
          ADD CONSTRAINT "rewards_eligibility_months_positive"
          CHECK ("eligibility_months" IS NULL OR "eligibility_months" > 0);
        END IF;
      END
      $$;
    `);
  },
};
