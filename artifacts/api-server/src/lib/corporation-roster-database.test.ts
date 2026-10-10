import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@workspace/db/schema";
import type { db } from "@workspace/db";
import { getWebsiteBoundCharacterIds } from "./corporation-roster-binding";

test("website binding requires ownership and authorization and does not accept fleet-discovered orphan records", async () => {
  const pg = new PGlite();
  try {
    await pg.exec(`
      CREATE TABLE users(id integer PRIMARY KEY, eve_character_id integer, corporation_id integer, access_token text, refresh_token text);
      CREATE TABLE characters(id integer PRIMARY KEY, user_id integer, eve_character_id integer, corporation_id integer, access_token text, refresh_token text, deleted_at timestamptz, membership_status text NOT NULL DEFAULT 'unknown');
      INSERT INTO users VALUES
        (1,101,1001,'authorized-main',NULL),
        (2,201,1001,NULL,'authorized-legacy'),
        (3,301,1001,NULL,NULL),
        (4,401,1001,'authorized-but-deleted',NULL),
        (5,501,1001,NULL,'authorized-but-departed'),
        (6,601,2002,NULL,'other-corp'),
        (7,NULL,1001,NULL,NULL);
      INSERT INTO characters VALUES
        (1,1,101,1001,NULL,'authorized-char',NULL,'member'),
        (2,1,102,1001,'authorized-alt',NULL,NULL,'member'),
        (3,NULL,103,1001,NULL,NULL,NULL,'member'),
        (4,3,301,1001,NULL,NULL,NULL,'member'),
        (5,4,401,1001,'deleted-token',NULL,'2026-09-01','member'),
        (6,5,501,1001,NULL,'departed-token',NULL,'departed'),
        (7,6,601,2002,NULL,'other-corp-token',NULL,'member'),
        (8,7,701,1001,NULL,'orphan-owner-token',NULL,'member');
    `);
    const database = drizzle(pg, { schema }) as unknown as typeof db;
    const bound = await getWebsiteBoundCharacterIds(1001, database);
    assert.deepEqual([...bound].sort((a, b) => a - b), [101, 102, 201]);
    assert.deepEqual([...await getWebsiteBoundCharacterIds(2002, database)], [601]);
  } finally {
    await pg.close();
  }
});
