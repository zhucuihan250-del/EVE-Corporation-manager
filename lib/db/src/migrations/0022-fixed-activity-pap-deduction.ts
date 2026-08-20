import type { PoolClient } from "pg";

export const fixedActivityPapDeductionMigration = {
  id: "0022_fixed_activity_pap_deduction",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      UPDATE "corporations"
      SET "activity_minimum_pap" = 2
      WHERE "activity_minimum_pap" <> 2;
    `);
  },
};
