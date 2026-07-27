import app from "./app";
import { pool, runMigrations } from "@workspace/db";
import { logger } from "./lib/logger";
import { CHARACTER_RETENTION_SWEEP_INTERVAL_MS, purgeExpiredDeletedCharacters } from "./lib/character-retention";

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
  const purgedCharacters = await purgeExpiredDeletedCharacters();
  if (purgedCharacters > 0) {
    logger.info({ purgedCharacters }, "Expired deleted characters purged");
  }
}

prepareDatabase()
  .then(() => {
    app.listen(port, "0.0.0.0", (err) => {
      if (err) {
        logger.error({ err }, "Error listening on port");
        process.exit(1);
      }
      logger.info({ host: "0.0.0.0", port }, "Server listening");

      const retentionSweep = setInterval(() => {
        purgeExpiredDeletedCharacters()
          .then((purgedCharacters) => {
            if (purgedCharacters > 0) {
              logger.info({ purgedCharacters }, "Expired deleted characters purged");
            }
          })
          .catch((err) => {
            logger.error({ err }, "Failed to purge expired deleted characters");
          });
      }, CHARACTER_RETENTION_SWEEP_INTERVAL_MS);
      retentionSweep.unref();
    });
  })
  .catch((err) => {
    logger.error({ err }, "Failed to prepare database, aborting");
    process.exit(1);
  });
