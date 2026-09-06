import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { diplomacyManagementMigration } from "../../../../lib/db/src/migrations/0027-diplomacy-management";

async function database() {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE corporations (id integer PRIMARY KEY);
    CREATE TABLE users (id serial PRIMARY KEY);
    CREATE TABLE diplomacy_cases (
      id serial PRIMARY KEY,
      corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE CASCADE,
      submitted_by integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'submitted',
      internal_notes text,
      assigned_to integer REFERENCES users(id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO corporations (id) VALUES (1001), (2002);
    INSERT INTO users DEFAULT VALUES;
    INSERT INTO users DEFAULT VALUES;
    INSERT INTO diplomacy_cases (corporation_id, submitted_by) VALUES (1001, 1), (2002, 2);
  `);
  await diplomacyManagementMigration.up({
    query: (sql: string) => pg.exec(sql),
  } as unknown as Parameters<typeof diplomacyManagementMigration.up>[0]);
  return pg;
}

test("diplomacy audit events cannot reference another corporation's case", async () => {
  const pg = await database();
  try {
    await assert.rejects(pg.query(`
      INSERT INTO diplomacy_case_events
        (corporation_id, case_id, actor_user_id, actor_name, event_type)
      VALUES (1001, 2, 1, 'Handler', 'assigned')
    `));
    await pg.query(`
      INSERT INTO diplomacy_case_events
        (corporation_id, case_id, actor_user_id, actor_name, event_type)
      VALUES (1001, 1, 1, 'Handler', 'assigned')
    `);
    const result = await pg.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM diplomacy_case_events");
    assert.equal(result.rows[0]?.count, 1);
  } finally {
    await pg.close();
  }
});

test("deleting a diplomacy case deletes only its own audit timeline", async () => {
  const pg = await database();
  try {
    await pg.query(`
      INSERT INTO diplomacy_case_events
        (corporation_id, case_id, actor_user_id, actor_name, event_type)
      VALUES
        (1001, 1, 1, 'Handler A', 'assigned'),
        (2002, 2, 2, 'Handler B', 'assigned')
    `);
    await pg.query("DELETE FROM diplomacy_cases WHERE corporation_id = 1001 AND id = 1");
    const result = await pg.query<{ corporation_id: number }>("SELECT corporation_id FROM diplomacy_case_events");
    assert.deepEqual(result.rows, [{ corporation_id: 2002 }]);
  } finally {
    await pg.close();
  }
});
