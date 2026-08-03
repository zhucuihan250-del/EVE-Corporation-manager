import type { PoolClient } from "pg";

export const reimbursementWindowMigration = {
  id: "0010_reimbursement_window",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "corporations"
        ADD COLUMN "reimbursement_open" boolean NOT NULL DEFAULT true;

      UPDATE "identity_groups"
      SET "permissions" = "permissions" || '["reimbursement.window.manage"]'::jsonb
      WHERE "name" = '总监组'
        AND NOT ("permissions" @> '["reimbursement.window.manage"]'::jsonb);
    `);
  },
};
