import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { systemMonitoringMigration } from "../../../../lib/db/src/migrations/0026-system-monitoring";
import { monitoredSystemRemovalMigration } from "../../../../lib/db/src/migrations/0028-monitored-system-removal";

async function database() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE corporations (id integer PRIMARY KEY);
    CREATE TABLE users (id serial PRIMARY KEY);
    INSERT INTO corporations (id) VALUES (1001), (2002);
    INSERT INTO users DEFAULT VALUES;
    INSERT INTO users DEFAULT VALUES;
  `);
  await systemMonitoringMigration.up({
    query: (sql: string) => pg.exec(sql),
  } as unknown as Parameters<typeof systemMonitoringMigration.up>[0]);
  await monitoredSystemRemovalMigration.up({
    query: (sql: string) => pg.exec(sql),
  } as unknown as Parameters<typeof monitoredSystemRemovalMigration.up>[0]);
  return pg;
}

test("system monitoring migration creates tenant-scoped constraints", async () => {
  const pg = await database();
  try {
    await pg.query(`
      INSERT INTO monitored_systems
        (corporation_id, solar_system_id, solar_system_name, created_by)
      VALUES (1001, 30000142, 'Jita', 1), (2002, 30004759, '1DQ1-A', 2)
    `);
    await pg.query(`
      INSERT INTO intel_bridges
        (corporation_id, owner_user_id, name, token_hash)
      VALUES (2002, 2, 'foreign bridge', 'token-2')
    `);
    await assert.rejects(
      pg.query(`
        INSERT INTO system_intel_events
          (corporation_id, monitor_id, relay_bridge_id, source, event_type, severity, confidence,
           solar_system_id, solar_system_name, summary, occurred_at, dedupe_key)
        VALUES
          (1001, 1, 1, 'chat', 'hostile_report', 'warning', 'reported',
           30000142, 'Jita', 'cross corporation bridge', now(), 'cross-bridge')
      `),
    );
    await assert.rejects(
      pg.query(`
        INSERT INTO system_intel_events
          (corporation_id, monitor_id, source, event_type, severity, confidence,
           solar_system_id, solar_system_name, summary, occurred_at, dedupe_key)
        VALUES
          (1001, 2, 'manual', 'hostile_report', 'warning', 'reported',
           30004759, '1DQ1-A', 'cross corporation monitor', now(), 'cross-monitor')
      `),
    );
  } finally {
    await pg.close();
  }
});

test("system monitoring migration keeps event history when a monitor is disabled", async () => {
  const pg = await database();
  try {
    await pg.query(`
      INSERT INTO monitored_systems
        (corporation_id, solar_system_id, solar_system_name, created_by)
      VALUES (1001, 30000142, 'Jita', 1)
    `);
    await pg.query(`
      INSERT INTO system_intel_events
        (corporation_id, monitor_id, source, event_type, severity, confidence,
         solar_system_id, solar_system_name, summary, occurred_at, dedupe_key)
      VALUES
        (1001, 1, 'manual', 'hostile_report', 'warning', 'reported',
         30000142, 'Jita', 'named report', now(), 'event-1')
    `);
    await pg.query(
      "UPDATE monitored_systems SET is_active = false WHERE id = 1",
    );
    const result = await pg.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM system_intel_events",
    );
    assert.equal(result.rows[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("removing a monitor preserves history and allows the same system to be restored", async () => {
  const pg = await database();
  try {
    await pg.query(`
      INSERT INTO monitored_systems
        (corporation_id, solar_system_id, solar_system_name, created_by)
      VALUES (1001, 30000142, 'Jita', 1)
    `);
    await pg.query(`
      INSERT INTO system_intel_events
        (corporation_id, monitor_id, source, event_type, severity, confidence,
         solar_system_id, solar_system_name, summary, occurred_at, dedupe_key)
      VALUES
        (1001, 1, 'manual', 'hostile_report', 'warning', 'reported',
         30000142, 'Jita', 'historic report', now(), 'event-removed')
    `);
    await pg.query(
      "UPDATE monitored_systems SET is_active = false, removed_at = now() WHERE corporation_id = 1001 AND id = 1",
    );
    const history = await pg.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM system_intel_events WHERE corporation_id = 1001 AND monitor_id = 1",
    );
    assert.equal(history.rows[0]?.count, 1);

    await pg.query(
      "UPDATE monitored_systems SET is_active = true, removed_at = NULL WHERE corporation_id = 1001 AND solar_system_id = 30000142",
    );
    const restored = await pg.query<{
      is_active: boolean;
      removed_at: Date | null;
    }>(
      "SELECT is_active, removed_at FROM monitored_systems WHERE corporation_id = 1001 AND id = 1",
    );
    assert.equal(restored.rows[0]?.is_active, true);
    assert.equal(restored.rows[0]?.removed_at, null);
  } finally {
    await pg.close();
  }
});

test("member deletion preserves monitoring configuration and bridge audit history", async () => {
  const pg = await database();
  try {
    await pg.query(`
      INSERT INTO monitored_systems
        (corporation_id, solar_system_id, solar_system_name, created_by)
      VALUES (1001, 30000142, 'Jita', 1)
    `);
    await pg.query(`
      INSERT INTO intel_bridges
        (corporation_id, owner_user_id, name, token_hash)
      VALUES (1001, 1, 'member bridge', 'member-token')
    `);
    await pg.query("DELETE FROM users WHERE id = 1");
    const monitor = await pg.query<{ created_by: number | null }>(
      "SELECT created_by FROM monitored_systems",
    );
    const bridge = await pg.query<{ owner_user_id: number | null }>(
      "SELECT owner_user_id FROM intel_bridges",
    );
    assert.equal(monitor.rows[0]?.created_by, null);
    assert.equal(bridge.rows[0]?.owner_user_id, null);
  } finally {
    await pg.close();
  }
});
