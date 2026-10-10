import app from "./app";
import { db, pool, runMigrations } from "@workspace/db";
import { logger } from "./lib/logger";
import { CHARACTER_RETENTION_SWEEP_INTERVAL_MS, runCharacterMembershipRetentionSweep } from "./lib/character-retention";
import {
  ACTIVITY_SETTLEMENT_SWEEP_INTERVAL_MS,
  settleDueActivityMonths,
} from "./lib/activity-monthly-settlement";
import { resumeRecentBattleReportGeneration } from "./lib/battle-reports";
import { startSystemMonitoringJobs } from "./lib/system-monitoring-jobs";
import { startDutyPapJobs } from "./lib/duty-pap-jobs";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

async function ensureSessionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS "session" (
      "sid" varchar NOT NULL COLLATE "default",
      "sess" json NOT NULL,
      "expire" timestamp(6) NOT NULL,
      CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
    ) WITH (OIDS=FALSE);

    CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "session" ("expire");
  `);
  logger.info("Session table ready");
}

async function prepareDatabase() {
  await runMigrations(pool);
  logger.info("Database migrations complete");
  await ensureSessionTable();
  const resumedBattleReports = await resumeRecentBattleReportGeneration();
  if (resumedBattleReports > 0) {
    logger.info(
      { resumedBattleReports },
      "Interrupted battle report jobs queued for recovery",
    );
  }
}

let membershipRetentionSweepRunning = false;
async function runMembershipRetentionSweep() {
  if (membershipRetentionSweepRunning) return;
  membershipRetentionSweepRunning = true;
  try {
    const result = await runCharacterMembershipRetentionSweep();
    logger.info(result, "Character membership retention sweep completed");
  } catch (err) {
    logger.error({ err }, "Failed to synchronize character membership retention");
  } finally {
    membershipRetentionSweepRunning = false;
  }
}

let activitySettlementSweepRunning = false;
async function runActivitySettlementSweep() {
  if (activitySettlementSweepRunning) return;
  activitySettlementSweepRunning = true;
  try {
    const result = await settleDueActivityMonths();
    if (result.settlementsCreated > 0) {
      logger.info(result, "Monthly activity PAP settlements completed");
    }
  } catch (err) {
    logger.error({ err }, "Failed to settle monthly activity PAP deductions");
  } finally {
    activitySettlementSweepRunning = false;
  }
}

prepareDatabase()
  .then(() => {
    const server = app.listen(port, "0.0.0.0", (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ host: "0.0.0.0", port }, "Server listening");

      const retentionSweep = setInterval(() => { void runMembershipRetentionSweep(); }, CHARACTER_RETENTION_SWEEP_INTERVAL_MS);
      retentionSweep.unref();

      void runMembershipRetentionSweep().then(() => runActivitySettlementSweep());
      const activitySettlementSweep = setInterval(() => {
        void runActivitySettlementSweep();
      }, ACTIVITY_SETTLEMENT_SWEEP_INTERVAL_MS);
      activitySettlementSweep.unref();
      startSystemMonitoringJobs();
      const dutyPapJobs = startDutyPapJobs({ database: db, pool, logger });
      let stopping = false;
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        clearInterval(retentionSweep);
        clearInterval(activitySettlementSweep);
        server.close();
        // Stop sampling before deployment replacement, including in-flight ESI
        // requests. Committed awards remain protected by their transaction key.
        const deadline = setTimeout(() => process.exit(0), 15_000);
        deadline.unref();
        void dutyPapJobs.stop().finally(() => {
          clearTimeout(deadline);
          server.closeAllConnections();
          process.exit(0);
        });
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to prepare database, aborting");
    process.exit(1);
  });
