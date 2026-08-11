import type { PoolClient } from "pg";

export const reimbursementReferencePricingMigration = {
  id: "0015_reimbursement_reference_pricing",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "reimbursement_claims"
        ADD COLUMN "jita_mid_value" double precision,
        ADD COLUMN "maximum_insurance_payout" double precision,
        ADD COLUMN "reference_reimbursement_amount" double precision,
        ADD COLUMN "reference_price_status" text NOT NULL DEFAULT 'pending',
        ADD COLUMN "reference_price_missing_type_count" integer NOT NULL DEFAULT 0,
        ADD COLUMN "reference_price_calculated_at" timestamptz;

      ALTER TABLE "reimbursement_claims"
        ADD CONSTRAINT "reimbursement_claims_reference_price_status_check"
        CHECK ("reference_price_status" IN ('pending', 'calculated', 'partial', 'unavailable'));
    `);
  },
};
