import type { PoolClient } from "pg";

export const tacticalGroupRewardsMigration = {
  id: "0024_tactical_group_rewards",
  async up(client: PoolClient): Promise<void> {
    // Existing rewards remain general. Never make group rewards public on group deletion.
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "identity_groups_corporation_id_unique"
        ON "identity_groups" ("corporation_id", "id");
      ALTER TABLE "rewards" ADD COLUMN "identity_group_id" integer;
      ALTER TABLE "rewards" ADD CONSTRAINT "rewards_identity_group_corporation_fk"
        FOREIGN KEY ("corporation_id", "identity_group_id")
        REFERENCES "identity_groups" ("corporation_id", "id") ON DELETE NO ACTION;
      CREATE INDEX "rewards_corporation_identity_group_idx"
        ON "rewards" ("corporation_id", "identity_group_id");
    `);
  },
};
