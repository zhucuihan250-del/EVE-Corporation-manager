/** Test-only @workspace/db alias; no external database or production credentials. */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

export * from "../../../../lib/db/src/schema/index";
export const pg = new PGlite();
export const db = drizzle(pg);

export async function initializeActivityFixture() {
  await pg.exec(`
    CREATE TABLE corporations (
      id integer PRIMARY KEY, name text NOT NULL, is_primary boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, pap_enabled boolean NOT NULL DEFAULT true,
      identity_enabled boolean NOT NULL DEFAULT true, economy_enabled boolean NOT NULL DEFAULT false,
      fleet_enabled boolean NOT NULL DEFAULT false, reimbursement_enabled boolean NOT NULL DEFAULT true,
      reimbursement_open boolean NOT NULL DEFAULT true, diplomacy_enabled boolean NOT NULL DEFAULT true,
      courier_enabled boolean NOT NULL DEFAULT false, structures_enabled boolean NOT NULL DEFAULT false,
      activity_minimum_pap double precision NOT NULL DEFAULT 2,
      activity_deduction_started_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE users (
      id serial PRIMARY KEY, eve_character_id integer, eve_character_name text,
      corporation_id integer, corporation_name text, corporation_joined_at timestamptz,
      access_token text, refresh_token text, token_expiry timestamptz, role text NOT NULL DEFAULT 'member',
      total_pap double precision NOT NULL DEFAULT 0, redeemable_pap double precision NOT NULL DEFAULT 0,
      locked_pap double precision NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE corporation_memberships (
      id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id),
      user_id integer NOT NULL REFERENCES users(id), role text NOT NULL DEFAULT 'member',
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(corporation_id,user_id));
    CREATE TABLE characters (
      id serial PRIMARY KEY, user_id integer REFERENCES users(id), eve_character_id integer NOT NULL,
      eve_character_name text NOT NULL, corporation_id integer REFERENCES corporations(id), corporation_name text,
      access_token text, refresh_token text, token_expiry timestamptz, is_main boolean NOT NULL DEFAULT false,
      deleted_at timestamptz, retained_until timestamptz, membership_status text NOT NULL DEFAULT 'unknown',
      actual_corporation_id integer, membership_checked_at timestamptz, corporation_left_at timestamptz,
      membership_retained_until timestamptz, retention_corporation_id integer,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE identity_groups(id integer PRIMARY KEY, corporation_id integer NOT NULL,
      permissions jsonb NOT NULL DEFAULT '[]', is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE identity_group_memberships(id serial PRIMARY KEY, corporation_id integer NOT NULL,
      group_id integer NOT NULL, user_id integer NOT NULL);
    CREATE TABLE activity_monthly_settlements (
      id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id), month text NOT NULL,
      period_start timestamptz NOT NULL, period_end timestamptz NOT NULL, minimum_pap double precision NOT NULL,
      eligible_member_count integer NOT NULL, total_deducted_pap double precision NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(corporation_id,month));
    CREATE TABLE pap_records (
      id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id), user_id integer NOT NULL REFERENCES users(id),
      character_id integer, fleet_id integer, amount double precision NOT NULL, currency_id integer, currency_name text,
      type text NOT NULL, reason text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE activity_monthly_deductions (
      id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id),
      settlement_id integer NOT NULL REFERENCES activity_monthly_settlements(id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES users(id), pap_record_id integer REFERENCES pap_records(id),
      amount double precision NOT NULL, total_pap_before double precision NOT NULL, total_pap_after double precision NOT NULL,
      redeemable_pap_before double precision NOT NULL, redeemable_pap_after double precision NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(settlement_id,user_id));
    CREATE TABLE pap_ledger (
      id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id), user_id integer REFERENCES users(id),
      user_name text NOT NULL, amount double precision NOT NULL DEFAULT 0, locked_delta double precision NOT NULL DEFAULT 0,
      type text NOT NULL, order_id integer, transaction_id integer, balance_after double precision NOT NULL,
      locked_after double precision NOT NULL, available_after double precision NOT NULL, admin_id integer,
      reason text, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE corporation_roster_connections (
      corporation_id integer PRIMARY KEY REFERENCES corporations(id), character_id integer NOT NULL, connected_by integer NOT NULL,
      access_token text NOT NULL, refresh_token text NOT NULL, token_expiry timestamptz NOT NULL,
      status text NOT NULL DEFAULT 'connected', last_error text, last_synced_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
  `);
}

export async function resetActivityFixture(now: Date, startedAt: Date) {
  await pg.exec(`TRUNCATE corporation_roster_connections, pap_ledger, activity_monthly_deductions, pap_records,
    activity_monthly_settlements, identity_group_memberships, identity_groups, characters, corporation_memberships,
    users, corporations RESTART IDENTITY;
    INSERT INTO corporations(id,name,is_primary) VALUES(1001,'Home',true),(2002,'Foreign',false);
    INSERT INTO users(id,eve_character_id,eve_character_name,corporation_id,corporation_joined_at,access_token,total_pap,redeemable_pap)
    VALUES
      (1,101,'Admin',1001,'2020-01-01','admin-fixture',100,100),
      (2,201,'Member',1001,'2020-01-01','member-fixture',0,0),
      (3,301,'Departed',1001,'2020-01-01','retained-fixture',42,42),
      (4,401,'Orphan',1001,'2020-01-01',NULL,42,42),
      (5,501,'Partial',1001,'2020-01-01','partial-fixture',1.25,1.25),
      (6,601,'New member',1001,'2020-01-01','new-fixture',0,0),
      (7,701,'Foreign',2002,'2020-01-01','foreign-fixture',42,42),
      (8,801,'Character token only',1001,'2020-01-01',NULL,0,0),
      (9,901,'Permission manager',1001,'2020-01-01','permission-fixture',0,0),
      (10,1001,'Deleted',1001,'2020-01-01','deleted-fixture',42,42);
    INSERT INTO corporation_memberships(corporation_id,user_id,role) VALUES
      (1001,1,'admin'),(1001,2,'member'),(1001,3,'member'),(1001,4,'member'),(1001,5,'member'),
      (1001,6,'member'),(2002,7,'admin'),(1001,8,'member'),(1001,9,'fc'),(1001,10,'member');
    INSERT INTO characters(user_id,eve_character_id,eve_character_name,corporation_id,is_main,access_token,membership_status)
      SELECT id,eve_character_id,eve_character_name,corporation_id,true,
        CASE WHEN id=8 THEN 'char-token-fixture' ELSE access_token END,
        CASE WHEN id=3 THEN 'departed' ELSE 'member' END FROM users WHERE id<>4;
    INSERT INTO characters(user_id,eve_character_id,eve_character_name,corporation_id,membership_status)
      VALUES(NULL,401,'Fleet discovered orphan',1001,'member');
    UPDATE characters SET deleted_at='2020-01-01' WHERE user_id=10;
    INSERT INTO identity_groups(id,corporation_id,permissions) VALUES(1,1001,'["activity.manage"]');
    INSERT INTO identity_group_memberships(corporation_id,group_id,user_id) VALUES(1001,1,9);`);
  await pg.query("UPDATE corporations SET activity_deduction_started_at=$1 WHERE id=1001", [startedAt.toISOString()]);
  await pg.query("UPDATE users SET corporation_joined_at=$1 WHERE id=6", [new Date(now.getTime() - 20 * 86400000).toISOString()]);
}
