import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import * as schema from "@workspace/db/schema";
import { activeAuthorizedActivityMemberPredicate } from "./activity-member-eligibility";

test("PAP candidate predicate excludes confirmed departures and deleted main characters even with legacy main tokens", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE TABLE users(id integer PRIMARY KEY, eve_character_id integer, eve_character_name text, corporation_id integer, access_token text, refresh_token text);
      CREATE TABLE characters(id integer PRIMARY KEY, user_id integer, eve_character_id integer, access_token text, refresh_token text, deleted_at timestamptz, membership_status text);
      INSERT INTO users VALUES
        (1,101,'Active',1001,NULL,'active-main'),
        (2,201,'Departed',1001,'retained-main-token',NULL),
        (3,301,'Deleted',1001,NULL,'retained-main-token'),
        (4,401,'Fleet orphan',1001,NULL,NULL),
        (5,501,'Unknown member',1001,'unknown-main-token',NULL),
        (6,601,'Char authorized',1001,NULL,NULL),
        (7,701,'Other corporation',2002,NULL,'other-token'),
        (8,801,'Only other char authorized',1001,NULL,NULL);
      INSERT INTO characters VALUES
        (1,1,101,NULL,'active-char',NULL,'member'),
        (2,2,201,NULL,'retained-char',NULL,'departed'),
        (3,3,301,NULL,'deleted-char','2026-09-01','member'),
        (4,NULL,401,NULL,NULL,NULL,'member'),
        (5,5,501,NULL,'unknown-char',NULL,'unknown'),
        (6,6,601,NULL,'authorized-char',NULL,'member'),
        (7,7,701,NULL,'other-char',NULL,'member'),
        (8,1,801,NULL,'different-owner-char',NULL,'member');
    `);
    const database = drizzle(pg, { schema });
    const candidates = await database.select({ id: schema.usersTable.id }).from(schema.usersTable)
      .where(and(eq(schema.usersTable.corporationId, 1001), activeAuthorizedActivityMemberPredicate()));
    assert.deepEqual(candidates.map((member) => member.id).sort((a, b) => a - b), [1, 5, 6]);
  } finally {
    await pg.close();
  }
});
