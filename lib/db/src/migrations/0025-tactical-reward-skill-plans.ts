import type { PoolClient } from "pg";

export const tacticalRewardSkillPlansMigration = {
  id: "0025_tactical_reward_skill_plans",
  async up(client: PoolClient): Promise<void> {
    // Existing rewards keep an empty plan set and therefore retain their current behavior.
    await client.query(`
      ALTER TABLE "rewards"
        ADD COLUMN "skill_plan_match_mode" text NOT NULL DEFAULT 'all'
        CHECK ("skill_plan_match_mode" IN ('all', 'any'));

      CREATE UNIQUE INDEX IF NOT EXISTS "rewards_corporation_id_unique"
        ON "rewards" ("corporation_id", "id");
      CREATE UNIQUE INDEX "rewards_corporation_group_id_unique"
        ON "rewards" ("corporation_id", "id", "identity_group_id");

      CREATE TABLE "reward_skill_plans" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "reward_id" integer NOT NULL,
        "identity_group_id" integer NOT NULL,
        "skill_plan_id" integer NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "reward_skill_plans_reward_group_fk"
          FOREIGN KEY ("corporation_id", "reward_id", "identity_group_id")
          REFERENCES "rewards"("corporation_id", "id", "identity_group_id") ON DELETE CASCADE,
        CONSTRAINT "reward_skill_plans_identity_group_plan_fk"
          FOREIGN KEY ("corporation_id", "identity_group_id", "skill_plan_id")
          REFERENCES "identity_group_skill_plans"("corporation_id", "group_id", "skill_plan_id") ON DELETE NO ACTION
      );
      CREATE UNIQUE INDEX "reward_skill_plans_reward_plan_unique"
        ON "reward_skill_plans" ("corporation_id", "reward_id", "skill_plan_id");
      CREATE INDEX "reward_skill_plans_group_plan_idx"
        ON "reward_skill_plans" ("corporation_id", "identity_group_id", "skill_plan_id");
    `);
  },
};
