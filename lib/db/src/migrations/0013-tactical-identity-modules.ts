import type { PoolClient } from "pg";

export const tacticalIdentityModulesMigration = {
  id: "0013_tactical_identity_modules",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "fleets"
        ADD COLUMN "identity_group_id" integer
        REFERENCES "identity_groups"("id") ON DELETE SET NULL;

      ALTER TABLE "reimbursement_claims"
        ADD COLUMN "identity_group_id" integer
        REFERENCES "identity_groups"("id") ON DELETE RESTRICT;

      CREATE INDEX "fleets_corporation_identity_group_idx"
        ON "fleets" ("corporation_id", "identity_group_id");
      CREATE INDEX "reimbursement_claims_corporation_identity_group_idx"
        ON "reimbursement_claims" ("corporation_id", "identity_group_id");
    `);
  },
};
