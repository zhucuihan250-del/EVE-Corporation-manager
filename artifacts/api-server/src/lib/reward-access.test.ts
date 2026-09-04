import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { and, eq } from "drizzle-orm";
import { rewardsTable } from "@workspace/db/schema";
import { tacticalGroupRewardsMigration } from "../../../../lib/db/src/migrations/0024-tactical-group-rewards";
import { tacticalRewardSkillPlansMigration } from "../../../../lib/db/src/migrations/0025-tactical-reward-skill-plans";
import {
  lockRewardMembership,
  replaceRewardSkillPlans,
  rewardMemberVisibility,
  RewardScopeError,
  validateRewardGroupTarget,
  validateRewardSkillPlanTargets,
} from "./reward-access";

const pg = new PGlite();
const db = drizzle(pg);
type RewardTransaction = Parameters<typeof validateRewardGroupTarget>[0];

before(async () => {
  await pg.exec(`
    CREATE TABLE corporations (id integer PRIMARY KEY, name text NOT NULL);
    CREATE TABLE identity_groups (id integer PRIMARY KEY, corporation_id integer NOT NULL,
      name text NOT NULL, category text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    -- Migration 0009 already created this index on existing installations.
    CREATE UNIQUE INDEX identity_groups_corporation_id_unique ON identity_groups (corporation_id, id);
    CREATE TABLE identity_group_memberships (id serial PRIMARY KEY, corporation_id integer NOT NULL,
      group_id integer NOT NULL, user_id integer NOT NULL, character_id integer);
    CREATE TABLE corporation_skill_plans (id integer PRIMARY KEY, corporation_id integer NOT NULL,
      name text NOT NULL, description text NOT NULL DEFAULT '', required_skills jsonb NOT NULL DEFAULT '[]'::jsonb,
      is_active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX corporation_skill_plans_corporation_id_unique
      ON corporation_skill_plans (corporation_id, id);
    CREATE TABLE identity_group_skill_plans (id serial PRIMARY KEY, corporation_id integer NOT NULL,
      group_id integer NOT NULL, skill_plan_id integer NOT NULL, created_at timestamptz DEFAULT now());
    CREATE UNIQUE INDEX identity_group_skill_plans_group_plan_unique
      ON identity_group_skill_plans (corporation_id, group_id, skill_plan_id);
    CREATE TABLE rewards (id integer PRIMARY KEY, corporation_id integer NOT NULL, name text NOT NULL,
      description text, pap_cost real NOT NULL DEFAULT 2, stock integer DEFAULT 5,
      eligibility_months integer, max_redemptions_per_user integer,
      is_available boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
    INSERT INTO rewards (id, corporation_id, name) VALUES (100, 1, 'Legacy reward');
    INSERT INTO corporations (id, name) VALUES (1, 'A'), (2, 'B');
  `);
  await tacticalGroupRewardsMigration.up({ query: (sql: string) => pg.exec(sql) } as unknown as Parameters<typeof tacticalGroupRewardsMigration.up>[0]);
  await tacticalRewardSkillPlansMigration.up({ query: (sql: string) => pg.exec(sql) } as unknown as Parameters<typeof tacticalRewardSkillPlansMigration.up>[0]);
  const legacy = await pg.query<{ identity_group_id: number | null }>("SELECT identity_group_id FROM rewards WHERE id=100");
  assert.equal(legacy.rows[0].identity_group_id, null, "migration must preserve legacy rewards as general");
  const legacyGate = await pg.query<{ skill_plan_match_mode: string }>("SELECT skill_plan_match_mode FROM rewards WHERE id=100");
  assert.equal(legacyGate.rows[0].skill_plan_match_mode, "all");
  assert.equal((await pg.query("SELECT 1 FROM reward_skill_plans WHERE reward_id=100")).rows.length, 0);
});

beforeEach(async () => {
  await pg.exec(`
    TRUNCATE reward_skill_plans, rewards, identity_group_memberships, identity_group_skill_plans,
      corporation_skill_plans, identity_groups;
    INSERT INTO identity_groups (id, corporation_id, name, category, is_active) VALUES
      (11, 1, 'A group', 'combat', true), (12, 1, 'B group', 'combat', true),
      (13, 1, 'Disabled', 'combat', false), (14, 1, 'FC', 'management', true),
      (21, 2, 'Other corporation group', 'combat', true);
    INSERT INTO identity_group_memberships (corporation_id, group_id, user_id) VALUES
      (1, 11, 101), (1, 12, 102), (1, 11, 103), (1, 12, 103),
      (1, 13, 101), (1, 14, 101), (2, 21, 201);
    INSERT INTO corporation_skill_plans (id, corporation_id, name, is_active) VALUES
      (301, 1, 'A doctrine', true), (302, 1, 'Inactive doctrine', false),
      (303, 1, 'B doctrine', true), (401, 2, 'Other doctrine', true);
    INSERT INTO identity_group_skill_plans (corporation_id, group_id, skill_plan_id) VALUES
      (1, 11, 301), (1, 11, 302), (1, 12, 303), (2, 21, 401);
    INSERT INTO rewards (id, corporation_id, name, identity_group_id) VALUES
      (1, 1, 'General A', null), (2, 1, 'A exclusive', 11), (3, 1, 'B exclusive', 12),
      (4, 1, 'Disabled exclusive', 13), (5, 1, 'Management legacy', 14),
      (6, 2, 'General other corporation', null), (7, 2, 'Other exclusive', 21);
    INSERT INTO reward_skill_plans (corporation_id, reward_id, identity_group_id, skill_plan_id)
      VALUES (1, 2, 11, 301);
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

test("reward skill plans can only come from the reward's own corporation and tactical group", async () => {
  await assert.rejects(
    pg.exec("INSERT INTO reward_skill_plans (corporation_id,reward_id,identity_group_id,skill_plan_id) VALUES (1,1,11,301)"),
    /foreign key/i,
  );
  await assert.rejects(
    pg.exec("INSERT INTO reward_skill_plans (corporation_id,reward_id,identity_group_id,skill_plan_id) VALUES (1,2,12,303)"),
    /foreign key/i,
  );
  await assert.rejects(
    pg.exec("INSERT INTO reward_skill_plans (corporation_id,reward_id,identity_group_id,skill_plan_id) VALUES (1,2,11,303)"),
    /foreign key/i,
  );
  await assert.rejects(
    pg.exec("INSERT INTO reward_skill_plans (corporation_id,reward_id,identity_group_id,skill_plan_id) VALUES (2,2,21,401)"),
    /foreign key/i,
  );
});

test("admin validation accepts only active plans currently attached to the selected group", async () => {
  await db.transaction(async (tx) => {
    const client = tx as unknown as RewardTransaction;
    await validateRewardSkillPlanTargets(client, 1, 11, [301]);
    await validateRewardSkillPlanTargets(client, 1, 11, []);
    await assert.rejects(validateRewardSkillPlanTargets(client, 1, null, [301]), RewardScopeError);
    await assert.rejects(validateRewardSkillPlanTargets(client, 1, 11, [302]), RewardScopeError);
    await assert.rejects(validateRewardSkillPlanTargets(client, 1, 11, [303]), RewardScopeError);
    await assert.rejects(validateRewardSkillPlanTargets(client, 1, 11, [401]), RewardScopeError);
  });
});

test("a plan used by a reward cannot be detached from its identity group", async () => {
  await assert.rejects(
    pg.exec("DELETE FROM identity_group_skill_plans WHERE corporation_id=1 AND group_id=11 AND skill_plan_id=301"),
    /foreign key/i,
  );
  await db.transaction(async (tx) => {
    await replaceRewardSkillPlans(tx as unknown as RewardTransaction, 1, 2, 11, []);
  });
  await pg.exec("DELETE FROM identity_group_skill_plans WHERE corporation_id=1 AND group_id=11 AND skill_plan_id=301");
});

test("group deletion cannot turn exclusive rewards public or erase them", async () => {
  await pg.exec("DELETE FROM identity_group_memberships WHERE group_id=11");
  await assert.rejects(pg.exec("DELETE FROM identity_groups WHERE id=11"), /foreign key/i);
  const result = await pg.query<{ identity_group_id: number }>("SELECT identity_group_id FROM rewards WHERE id=2");
  assert.equal(result.rows[0].identity_group_id, 11);
});

test("reassigning a reward changes eligibility on the next lookup; making it general is explicit", async () => {
  await pg.exec("DELETE FROM reward_skill_plans WHERE corporation_id=1 AND reward_id=2");
  await pg.exec("UPDATE rewards SET identity_group_id=12 WHERE id=2");
  assert.deepEqual(await visibleIds(1, 101), [1]);
  assert.deepEqual(await visibleIds(1, 102), [1, 2, 3]);
  await pg.exec("UPDATE rewards SET identity_group_id=null WHERE id=2");
  assert.deepEqual(await visibleIds(1, 101), [1, 2]);
});
