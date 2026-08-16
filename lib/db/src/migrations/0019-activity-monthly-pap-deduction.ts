import type { PoolClient } from "pg";

export const activityMonthlyPapDeductionMigration = {
  id: "0019_activity_monthly_pap_deduction",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "corporations"
        ADD COLUMN "activity_deduction_started_at" timestamptz NOT NULL DEFAULT now();

      CREATE TABLE "activity_monthly_settlements" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "month" text NOT NULL CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
        "period_start" timestamptz NOT NULL,
        "period_end" timestamptz NOT NULL,
        "minimum_pap" double precision NOT NULL CHECK ("minimum_pap" >= 0),
        "eligible_member_count" integer NOT NULL CHECK ("eligible_member_count" >= 0),
        "total_deducted_pap" double precision NOT NULL CHECK ("total_deducted_pap" >= 0),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CHECK ("period_end" > "period_start")
      );
      CREATE UNIQUE INDEX "activity_monthly_settlements_corporation_month_unique"
        ON "activity_monthly_settlements" ("corporation_id", "month");
      CREATE UNIQUE INDEX "activity_monthly_settlements_corporation_id_unique"
        ON "activity_monthly_settlements" ("corporation_id", "id");

      CREATE TABLE "activity_monthly_deductions" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "settlement_id" integer NOT NULL REFERENCES "activity_monthly_settlements"("id") ON DELETE CASCADE,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "pap_record_id" integer REFERENCES "pap_records"("id") ON DELETE SET NULL,
        "amount" double precision NOT NULL CHECK ("amount" >= 0),
        "total_pap_before" double precision NOT NULL,
        "total_pap_after" double precision NOT NULL,
        "redeemable_pap_before" double precision NOT NULL,
        "redeemable_pap_after" double precision NOT NULL CHECK ("redeemable_pap_after" >= 0),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "activity_monthly_deductions_corporation_settlement_fk"
          FOREIGN KEY ("corporation_id", "settlement_id")
          REFERENCES "activity_monthly_settlements"("corporation_id", "id") ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX "activity_monthly_deductions_settlement_user_unique"
        ON "activity_monthly_deductions" ("settlement_id", "user_id");
      CREATE INDEX "activity_monthly_deductions_corporation_user_idx"
        ON "activity_monthly_deductions" ("corporation_id", "user_id");
    `);
  },
};
