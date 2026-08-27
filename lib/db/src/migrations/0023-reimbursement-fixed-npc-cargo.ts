import type { PoolClient } from "pg";

export const reimbursementFixedNpcCargoMigration = {
  id: "0023_reimbursement_fixed_npc_cargo",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "reimbursement_claims"
        ADD COLUMN "fixed_npc_cargo_value" double precision NOT NULL DEFAULT 0,
        ADD COLUMN "fixed_npc_cargo_deductions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN "fixed_npc_cargo_calculated_at" timestamptz;
    `);
  },
};
