import type { PoolClient } from "pg";

export const unifiedPapBalanceMigration = {
  id: "0020_unified_pap_balance",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      UPDATE "users"
      SET
        "redeemable_pap" = GREATEST(0::real, "redeemable_pap"),
        "total_pap" = GREATEST(0::real, "redeemable_pap")
      WHERE "total_pap" IS DISTINCT FROM GREATEST(0::real, "redeemable_pap")
         OR "redeemable_pap" < 0;

      ALTER TABLE "users"
        ADD CONSTRAINT "users_pap_balance_nonnegative"
          CHECK ("redeemable_pap" >= 0),
        ADD CONSTRAINT "users_pap_balances_mirrored"
          CHECK ("total_pap" = "redeemable_pap");
    `);
  },
};
