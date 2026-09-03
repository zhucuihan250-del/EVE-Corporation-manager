import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { rewardsTable } from "@workspace/db/schema";
import { tacticalGroupRewardsMigration } from "../../../../lib/db/src/migrations/0024-tactical-group-rewards";
import { lockRewardMembership, rewardMemberVisibility, RewardScopeError, validateRewardGroupTarget } from "./reward-access";

const pg = new PGlite();
const db = drizzle(pg);
type RewardTransaction = Parameters<typeof validateRewardGroupTarget>[0];

before(async () => {
  await pg.exec(`
    CREATE TABLE identity_groups (id integer PRIMARY KEY, corporation_id integer NOT NULL,
      name text NOT NULL, category text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    -- Migration 0009 already created this index on existing installations.
    CREATE UNIQUE INDEX identity_groups_corporation_id_unique ON identity_groups (corporation_id, id);
    CREATE TABLE identity_group_memberships (id serial PRIMARY KEY, corporation_id integer NOT NULL,
      group_id integer NOT NULL, user_id integer NOT NULL);
    CREATE TABLE rewards (id integer PRIMARY KEY, corporation_id integer NOT NULL, name text NOT NULL,
      description text, pap_cost real NOT NULL DEFAULT 2, stock integer DEFAULT 5,
      eligibility_months integer, max_redemptions_per_user integer,
      is_available boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    INSERT INTO rewards (id, corporation_id, name) VALUES (100, 1, 'Legacy reward');
  `);
  await tacticalGroupRewardsMigration.up({ query: (sql: string) => pg.exec(sql) } as unknown as Parameters<typeof tacticalGroupRewardsMigration.up>[0]);
  const legacy = await pg.query<{ identity_group_id: number | null }>("SELECT identity_group_id FROM rewards WHERE id=100");
  assert.equal(legacy.rows[0].identity_group_id, null, "migration must preserve legacy rewards as general");
});

beforeEach(async () => {
  await pg.exec(`
    TRUNCATE rewards, identity_group_memberships, identity_groups;
    INSERT INTO identity_groups (id, corporation_id, name, category, is_active) VALUES
      (11, 1, 'A group', 'combat', true), (12, 1, 'B group', 'combat', true),
      (13, 1, 'Disabled', 'combat', false), (14, 1, 'FC', 'management', true),
      (21, 2, 'Other corporation group', 'combat', true);
    INSERT INTO identity_group_memberships (corporation_id, group_id, user_id) VALUES
      (1, 11, 101), (1, 12, 102), (1, 11, 103), (1, 12, 103),
      (1, 13, 101), (1, 14, 101), (2, 21, 201);
    INSERT INTO rewards (id, corporation_id, name, identity_group_id) VALUES
      (1, 1, 'General A', null), (2, 1, 'A exclusive', 11), (3, 1, 'B exclusive', 12),
      (4, 1, 'Disabled exclusive', 13), (5, 1, 'Management legacy', 14),
      (6, 2, 'General other corporation', null), (7, 2, 'Other exclusive', 21);
  `);
});

after(async () => { await pg.close(); });

async function visibleIds(corporationId: number, userId: number, enabled = true) {
  const rows = await db.select({ id: rewardsTable.id }).from(rewardsTable)
    .where(rewardMemberVisibility(corporationId, userId, enabled)).orderBy(rewardsTable.id);
  return rows.map((row) => row.id);
}

test("members see general rewards plus only their active tactical group rewards", async () => {
  assert.deepEqual(await visibleIds(1, 101), [1, 2]);
  assert.deepEqual(await visibleIds(1, 102), [1, 3]);
  assert.deepEqual(await visibleIds(1, 103), [1, 2, 3]);
  assert.deepEqual(await visibleIds(1, 999), [1]);
});

test("corporation isolation applies even to a user who belongs to both corporations", async () => {
  await pg.exec("INSERT INTO identity_group_memberships (corporation_id, group_id, user_id) VALUES (2, 21, 101)");
  assert.deepEqual(await visibleIds(1, 101), [1, 2]);
  assert.deepEqual(await visibleIds(2, 101), [6, 7]);
  assert.deepEqual(await visibleIds(2, 201), [6, 7]);
});

test("mismatched legacy membership corporation cannot grant access", async () => {
  await pg.exec("INSERT INTO identity_group_memberships (corporation_id, group_id, user_id) VALUES (2, 11, 999), (1, 21, 999)");
  assert.deepEqual(await visibleIds(1, 999), [1]);
  assert.deepEqual(await visibleIds(2, 999), [6]);
});

test("disabling identity module hides restricted rewards while preserving general rewards", async () => {
  assert.deepEqual(await visibleIds(1, 101, false), [1]);
});

test("guessing another group's or corporation's reward ID returns no redeemable row", async () => {
  for (const id of [3, 4, 5, 6, 7]) {
    const rows = await db.select().from(rewardsTable).where(and(
      eq(rewardsTable.id, id), rewardMemberVisibility(1, 101, true),
    ));
    assert.equal(rows.length, 0);
  }
});

test("leaving a group immediately removes visibility and redemption membership", async () => {
  assert.deepEqual(await visibleIds(1, 101), [1, 2]);
  await pg.exec("DELETE FROM identity_group_memberships WHERE corporation_id=1 AND group_id=11 AND user_id=101");
  assert.deepEqual(await visibleIds(1, 101), [1]);
  await db.transaction(async (tx) => assert.equal(await lockRewardMembership(tx as unknown as RewardTransaction, 1, 101, 11), false));
});

test("disabling or changing group category removes eligibility; closing applications does not affect current membership", async () => {
  await pg.exec("ALTER TABLE identity_groups ADD COLUMN IF NOT EXISTS application_open boolean DEFAULT true; UPDATE identity_groups SET application_open=false WHERE id=11");
  assert.deepEqual(await visibleIds(1, 101), [1, 2]);
  await pg.exec("UPDATE identity_groups SET is_active=false WHERE id=11");
  assert.deepEqual(await visibleIds(1, 101), [1]);
  await db.transaction(async (tx) => assert.equal(await lockRewardMembership(tx as unknown as RewardTransaction, 1, 101, 11), false));
  await pg.exec("UPDATE identity_groups SET is_active=true, category='management' WHERE id=11");
  assert.deepEqual(await visibleIds(1, 101), [1]);
});

test("redemption membership lock requires current membership, regardless of administrator status", async () => {
  await db.transaction(async (tx) => {
    const client = tx as unknown as RewardTransaction;
    assert.equal(await lockRewardMembership(client, 1, 101, 11), true);
    assert.equal(await lockRewardMembership(client, 1, 999, 11), false);
    assert.equal(await lockRewardMembership(client, 1, 101, 21), false);
  });
});

test("admin may target only active combat groups in this corporation", async () => {
  for (const id of [0, -1, 1.5, 13, 14, 21, 999]) {
    await assert.rejects(db.transaction((tx) => validateRewardGroupTarget(tx as unknown as RewardTransaction, 1, id, true)), RewardScopeError);
  }
  await assert.rejects(db.transaction((tx) => validateRewardGroupTarget(tx as unknown as RewardTransaction, 1, 11, false)), RewardScopeError);
  await db.transaction(async (tx) => {
    await validateRewardGroupTarget(tx as unknown as RewardTransaction, 1, 11, true);
    await validateRewardGroupTarget(tx as unknown as RewardTransaction, 1, null, false);
    await validateRewardGroupTarget(tx as unknown as RewardTransaction, 1, undefined, false);
  });
});

test("database rejects cross-corporation reward assignments even without API validation", async () => {
  await assert.rejects(pg.exec("UPDATE rewards SET identity_group_id=21 WHERE id=2"), /foreign key/i);
  await assert.rejects(pg.exec("UPDATE rewards SET identity_group_id=999 WHERE id=2"), /foreign key/i);
});

test("group deletion cannot turn exclusive rewards public or erase them", async () => {
  await pg.exec("DELETE FROM identity_group_memberships WHERE group_id=11");
  await assert.rejects(pg.exec("DELETE FROM identity_groups WHERE id=11"), /foreign key/i);
  const result = await pg.query<{ identity_group_id: number }>("SELECT identity_group_id FROM rewards WHERE id=2");
  assert.equal(result.rows[0].identity_group_id, 11);
});

test("reassigning a reward changes eligibility on the next lookup; making it general is explicit", async () => {
  await pg.exec("UPDATE rewards SET identity_group_id=12 WHERE id=2");
  assert.deepEqual(await visibleIds(1, 101), [1]);
  assert.deepEqual(await visibleIds(1, 102), [1, 2, 3]);
  await pg.exec("UPDATE rewards SET identity_group_id=null WHERE id=2");
  assert.deepEqual(await visibleIds(1, 101), [1, 2]);
});
