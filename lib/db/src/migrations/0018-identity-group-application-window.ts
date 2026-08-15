import type { PoolClient } from "pg";

export const identityGroupApplicationWindowMigration = {
  id: "0018_identity_group_application_window",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "identity_groups"
        ADD COLUMN "application_open" boolean NOT NULL DEFAULT true;
    `);
  },
};
