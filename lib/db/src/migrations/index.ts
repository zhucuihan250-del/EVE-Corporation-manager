import type { Pool, PoolClient } from "pg";
import { redemptionRewardNameSnapshotMigration } from "./0001-redemption-reward-name-snapshot";
import { limitedTimeRewardsMigration } from "./0002-limited-time-rewards";
import { rewardRedemptionLimitsMigration } from "./0003-reward-redemption-limits";
import { fleetBattleReportsMigration } from "./0004-fleet-battle-reports";
import { battleReportReviewsMigration } from "./0005-battle-report-reviews";
import { battleReportAttackersMigration } from "./0006-battle-report-attackers";
import { characterSoftDeleteRetentionMigration } from "./0007-character-soft-delete-retention";
import { userMainCharacterNullableMigration } from "./0008-user-main-character-nullable";
import { corporationPlatformModulesMigration } from "./0009-corporation-platform-modules";
import { reimbursementWindowMigration } from "./0010-reimbursement-window";
import { activityIdentityManagementMigration } from "./0011-activity-identity-management";
import { corporationRosterAuditMigration } from "./0012-corporation-roster-audit";
import { tacticalIdentityModulesMigration } from "./0013-tactical-identity-modules";
import { courierModuleMigration } from "./0014-courier-module";
import { reimbursementReferencePricingMigration } from "./0015-reimbursement-reference-pricing";
import { redemptionApplicantSnapshotMigration } from "./0016-redemption-applicant-snapshot";
import { corporationStructuresMigration } from "./0017-corporation-structures";
import { identityGroupApplicationWindowMigration } from "./0018-identity-group-application-window";
import { activityMonthlyPapDeductionMigration } from "./0019-activity-monthly-pap-deduction";
import { unifiedPapBalanceMigration } from "./0020-unified-pap-balance";
import { papMarketMigration } from "./0021-pap-market";
import { fixedActivityPapDeductionMigration } from "./0022-fixed-activity-pap-deduction";
import { reimbursementFixedNpcCargoMigration } from "./0023-reimbursement-fixed-npc-cargo";
import { tacticalGroupRewardsMigration } from "./0024-tactical-group-rewards";

type Migration = {
  id: string;
  up(client: PoolClient): Promise<void>;
};

const migrations: Migration[] = [
  redemptionRewardNameSnapshotMigration,
  limitedTimeRewardsMigration,
  rewardRedemptionLimitsMigration,
  fleetBattleReportsMigration,
  battleReportReviewsMigration,
  battleReportAttackersMigration,
  characterSoftDeleteRetentionMigration,
  userMainCharacterNullableMigration,
  corporationPlatformModulesMigration,
  reimbursementWindowMigration,
  activityIdentityManagementMigration,
  corporationRosterAuditMigration,
  tacticalIdentityModulesMigration,
  courierModuleMigration,
  reimbursementReferencePricingMigration,
  redemptionApplicantSnapshotMigration,
  corporationStructuresMigration,
  identityGroupApplicationWindowMigration,
  activityMonthlyPapDeductionMigration,
  unifiedPapBalanceMigration,
  papMarketMigration,
  fixedActivityPapDeductionMigration,
  reimbursementFixedNpcCargoMigration,
  tacticalGroupRewardsMigration,
];

export async function runMigrations(pool: Pool): Promise<void> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(
      "SELECT pg_advisory_xact_lock($1::integer, $2::integer)",
      [20260720, 1],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS "app_migrations" (
        "id" text PRIMARY KEY,
        "applied_at" timestamp with time zone NOT NULL DEFAULT now()
      );
    `);

    for (const migration of migrations) {
      const applied = await client.query(
        'SELECT 1 FROM "app_migrations" WHERE "id" = $1',
        [migration.id],
      );

      if (applied.rowCount) {
        continue;
      }

      await migration.up(client);
      await client.query('INSERT INTO "app_migrations" ("id") VALUES ($1)', [
        migration.id,
      ]);
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
