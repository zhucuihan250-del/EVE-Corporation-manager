import type { PoolClient } from "pg";

export const corporationPlatformModulesMigration = {
  id: "0009_corporation_platform_modules",
  async up(client: PoolClient): Promise<void> {
    const configuredPrimaryId = Number(process.env.PRIMARY_CORPORATION_ID);
    const configuredPrimarySql = Number.isInteger(configuredPrimaryId) && configuredPrimaryId > 0
      ? String(configuredPrimaryId)
      : "NULL";
    await client.query(`
      CREATE TABLE "corporations" (
        "id" integer PRIMARY KEY,
        "name" text NOT NULL,
        "is_primary" boolean NOT NULL DEFAULT false,
        "is_active" boolean NOT NULL DEFAULT true,
        "pap_enabled" boolean NOT NULL DEFAULT false,
        "identity_enabled" boolean NOT NULL DEFAULT false,
        "economy_enabled" boolean NOT NULL DEFAULT false,
        "fleet_enabled" boolean NOT NULL DEFAULT false,
        "reimbursement_enabled" boolean NOT NULL DEFAULT true,
        "diplomacy_enabled" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "corporations_one_primary_unique"
        ON "corporations" ((true)) WHERE "is_primary" = true;

      INSERT INTO "corporations" ("id", "name")
      SELECT "corporation_id", MAX(COALESCE(NULLIF("corporation_name", ''), 'Corporation ' || "corporation_id"::text))
      FROM "users"
      WHERE "corporation_id" IS NOT NULL AND "corporation_id" > 0
      GROUP BY "corporation_id"
      ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name";

      INSERT INTO "corporations" ("id", "name")
      SELECT "corporation_id", MAX(COALESCE(NULLIF("corporation_name", ''), 'Corporation ' || "corporation_id"::text))
      FROM "characters"
      WHERE "corporation_id" IS NOT NULL AND "corporation_id" > 0
      GROUP BY "corporation_id"
      ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name";

      INSERT INTO "corporations" ("id", "name", "is_primary", "pap_enabled", "identity_enabled", "economy_enabled", "fleet_enabled")
      SELECT 1, 'Legacy Corporation', true, true, true, true, true
      WHERE NOT EXISTS (SELECT 1 FROM "corporations")
        AND (
          EXISTS (SELECT 1 FROM "fleets")
          OR EXISTS (SELECT 1 FROM "pap_records")
          OR EXISTS (SELECT 1 FROM "battle_reports")
          OR EXISTS (SELECT 1 FROM "rewards")
          OR EXISTS (SELECT 1 FROM "redemptions")
          OR EXISTS (SELECT 1 FROM "announcements")
        );

      WITH chosen AS (
        SELECT COALESCE(
          (SELECT "id" FROM "corporations" WHERE "id" = ${configuredPrimarySql}),
          (SELECT "corporation_id" FROM "users"
           WHERE "corporation_id" IS NOT NULL AND "corporation_id" > 0
           ORDER BY CASE "role" WHEN 'controller' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, "id"
           LIMIT 1),
          (SELECT "id" FROM "corporations" ORDER BY "id" LIMIT 1)
        ) AS "corporation_id"
      )
      UPDATE "corporations"
      SET
        "is_primary" = true,
        "pap_enabled" = true,
        "identity_enabled" = true,
        "economy_enabled" = true,
        "fleet_enabled" = true
      WHERE "id" = (SELECT "corporation_id" FROM chosen)
        AND NOT EXISTS (SELECT 1 FROM "corporations" WHERE "is_primary" = true);

      CREATE TABLE "corporation_memberships" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "role" text NOT NULL DEFAULT 'member' CHECK ("role" IN ('member', 'fc', 'admin', 'controller')),
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "corporation_memberships_corporation_user_unique"
        ON "corporation_memberships" ("corporation_id", "user_id");

      INSERT INTO "corporation_memberships" ("corporation_id", "user_id", "role")
      SELECT "corporation_id", "id", "role"
      FROM "users"
      WHERE "corporation_id" IS NOT NULL AND "corporation_id" > 0
      ON CONFLICT ("corporation_id", "user_id") DO NOTHING;

      INSERT INTO "corporation_memberships" ("corporation_id", "user_id", "role")
      SELECT DISTINCT c."corporation_id", c."user_id", 'member'
      FROM "characters" c
      WHERE c."corporation_id" IS NOT NULL AND c."corporation_id" > 0 AND c."user_id" IS NOT NULL
      ON CONFLICT ("corporation_id", "user_id") DO NOTHING;

      ALTER TABLE "characters"
        ADD COLUMN "access_token" text,
        ADD COLUMN "refresh_token" text,
        ADD COLUMN "token_expiry" timestamptz;
      UPDATE "characters" c
      SET
        "access_token" = u."access_token",
        "refresh_token" = u."refresh_token",
        "token_expiry" = u."token_expiry"
      FROM "users" u
      WHERE c."user_id" = u."id" AND c."is_main" = true;
      UPDATE "characters" SET "corporation_id" = NULL, "corporation_name" = NULL
      WHERE "corporation_id" IS NOT NULL AND "corporation_id" <= 0;

      ALTER TABLE "fleets"
        ADD COLUMN "corporation_id" integer,
        ADD COLUMN "fleet_function" text NOT NULL DEFAULT 'general',
        ADD COLUMN "reimbursement_enabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN "reimbursement_rule" jsonb;
      ALTER TABLE "pap_records" ADD COLUMN "corporation_id" integer;
      ALTER TABLE "battle_reports" ADD COLUMN "corporation_id" integer;
      ALTER TABLE "rewards" ADD COLUMN "corporation_id" integer;
      ALTER TABLE "redemptions" ADD COLUMN "corporation_id" integer;
      ALTER TABLE "announcements" ADD COLUMN "corporation_id" integer;

      UPDATE "pap_records" p
      SET "corporation_id" = u."corporation_id"
      FROM "users" u
      WHERE p."user_id" = u."id" AND u."corporation_id" IS NOT NULL;

      UPDATE "redemptions" r
      SET "corporation_id" = u."corporation_id"
      FROM "users" u
      WHERE r."user_id" = u."id" AND u."corporation_id" IS NOT NULL;

      UPDATE "fleets"
      SET "corporation_id" = (SELECT "id" FROM "corporations" WHERE "is_primary" = true LIMIT 1)
      WHERE "corporation_id" IS NULL;
      UPDATE "pap_records" p
      SET "corporation_id" = f."corporation_id"
      FROM "fleets" f
      WHERE p."fleet_id" = f."id";
      UPDATE "battle_reports" b
      SET "corporation_id" = COALESCE(
        (SELECT f."corporation_id" FROM "fleets" f WHERE f."id" = b."fleet_id"),
        (SELECT "id" FROM "corporations" WHERE "is_primary" = true LIMIT 1)
      )
      WHERE "corporation_id" IS NULL;
      UPDATE "rewards"
      SET "corporation_id" = (SELECT "id" FROM "corporations" WHERE "is_primary" = true LIMIT 1)
      WHERE "corporation_id" IS NULL;
      UPDATE "redemptions" r
      SET "corporation_id" = rw."corporation_id"
      FROM "rewards" rw
      WHERE r."reward_id" = rw."id";
      UPDATE "announcements"
      SET "corporation_id" = (SELECT "id" FROM "corporations" WHERE "is_primary" = true LIMIT 1)
      WHERE "corporation_id" IS NULL;
      UPDATE "pap_records"
      SET "corporation_id" = (SELECT "id" FROM "corporations" WHERE "is_primary" = true LIMIT 1)
      WHERE "corporation_id" IS NULL;
      UPDATE "redemptions"
      SET "corporation_id" = (SELECT "id" FROM "corporations" WHERE "is_primary" = true LIMIT 1)
      WHERE "corporation_id" IS NULL;

      INSERT INTO "corporation_memberships" ("corporation_id", "user_id", "role")
      SELECT DISTINCT "corporation_id", "user_id", 'member' FROM "pap_records"
      ON CONFLICT ("corporation_id", "user_id") DO NOTHING;
      INSERT INTO "corporation_memberships" ("corporation_id", "user_id", "role")
      SELECT DISTINCT "corporation_id", "user_id", 'member' FROM "redemptions"
      ON CONFLICT ("corporation_id", "user_id") DO NOTHING;

      ALTER TABLE "fleets" ALTER COLUMN "corporation_id" SET NOT NULL;
      ALTER TABLE "pap_records" ALTER COLUMN "corporation_id" SET NOT NULL;
      ALTER TABLE "battle_reports" ALTER COLUMN "corporation_id" SET NOT NULL;
      ALTER TABLE "rewards" ALTER COLUMN "corporation_id" SET NOT NULL;
      ALTER TABLE "redemptions" ALTER COLUMN "corporation_id" SET NOT NULL;
      ALTER TABLE "announcements" ALTER COLUMN "corporation_id" SET NOT NULL;

      ALTER TABLE "fleets" ADD CONSTRAINT "fleets_corporation_fk" FOREIGN KEY ("corporation_id") REFERENCES "corporations"("id") ON DELETE CASCADE;
      ALTER TABLE "pap_records" ADD CONSTRAINT "pap_records_corporation_fk" FOREIGN KEY ("corporation_id") REFERENCES "corporations"("id") ON DELETE CASCADE;
      ALTER TABLE "battle_reports" ADD CONSTRAINT "battle_reports_corporation_fk" FOREIGN KEY ("corporation_id") REFERENCES "corporations"("id") ON DELETE CASCADE;
      ALTER TABLE "rewards" ADD CONSTRAINT "rewards_corporation_fk" FOREIGN KEY ("corporation_id") REFERENCES "corporations"("id") ON DELETE CASCADE;
      ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_corporation_fk" FOREIGN KEY ("corporation_id") REFERENCES "corporations"("id") ON DELETE CASCADE;
      ALTER TABLE "announcements" ADD CONSTRAINT "announcements_corporation_fk" FOREIGN KEY ("corporation_id") REFERENCES "corporations"("id") ON DELETE CASCADE;

      CREATE INDEX "fleets_corporation_idx" ON "fleets" ("corporation_id");
      CREATE INDEX "pap_records_corporation_idx" ON "pap_records" ("corporation_id");
      CREATE INDEX "battle_reports_corporation_idx" ON "battle_reports" ("corporation_id");
      CREATE INDEX "rewards_corporation_idx" ON "rewards" ("corporation_id");
      CREATE INDEX "redemptions_corporation_idx" ON "redemptions" ("corporation_id");
      CREATE INDEX "announcements_corporation_idx" ON "announcements" ("corporation_id");
      ALTER TABLE "characters" ADD CONSTRAINT "characters_corporation_fk" FOREIGN KEY ("corporation_id") REFERENCES "corporations"("id") ON DELETE SET NULL;
      CREATE UNIQUE INDEX "characters_corporation_id_unique" ON "characters" ("corporation_id", "id");
      CREATE UNIQUE INDEX "fleets_corporation_id_unique" ON "fleets" ("corporation_id", "id");
      CREATE UNIQUE INDEX "rewards_corporation_id_unique" ON "rewards" ("corporation_id", "id");
      ALTER TABLE "pap_records" ADD CONSTRAINT "pap_records_corporation_fleet_fk" FOREIGN KEY ("corporation_id", "fleet_id") REFERENCES "fleets"("corporation_id", "id");
      ALTER TABLE "pap_records" ADD CONSTRAINT "pap_records_corporation_user_fk" FOREIGN KEY ("corporation_id", "user_id") REFERENCES "corporation_memberships"("corporation_id", "user_id") ON DELETE CASCADE;
      ALTER TABLE "battle_reports" ADD CONSTRAINT "battle_reports_corporation_fleet_fk" FOREIGN KEY ("corporation_id", "fleet_id") REFERENCES "fleets"("corporation_id", "id");
      ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_corporation_reward_fk" FOREIGN KEY ("corporation_id", "reward_id") REFERENCES "rewards"("corporation_id", "id") ON DELETE CASCADE;
      ALTER TABLE "redemptions" ADD CONSTRAINT "redemptions_corporation_user_fk" FOREIGN KEY ("corporation_id", "user_id") REFERENCES "corporation_memberships"("corporation_id", "user_id") ON DELETE CASCADE;

      CREATE TABLE "identity_groups" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "name" text NOT NULL,
        "category" text NOT NULL CHECK ("category" IN ('combat', 'management')),
        "description" text NOT NULL DEFAULT '',
        "required_skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "permissions" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "identity_groups_corporation_name_unique" ON "identity_groups" ("corporation_id", "name");
      CREATE UNIQUE INDEX "identity_groups_corporation_id_unique" ON "identity_groups" ("corporation_id", "id");

      CREATE TABLE "identity_group_applications" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "group_id" integer NOT NULL REFERENCES "identity_groups"("id") ON DELETE CASCADE,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "character_id" integer NOT NULL REFERENCES "characters"("id") ON DELETE RESTRICT,
        "statement" text NOT NULL DEFAULT '',
        "status" text NOT NULL DEFAULT 'pending_skill_audit' CHECK ("status" IN ('pending_skill_audit', 'pending_review', 'needs_information', 'approved', 'rejected', 'withdrawn')),
        "skill_audit" jsonb,
        "rejection_reason" text,
        "reviewer_notes" text,
        "reviewed_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "reviewed_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "identity_group_applications_corporation_idx" ON "identity_group_applications" ("corporation_id", "created_at" DESC);
      ALTER TABLE "identity_group_applications" ADD CONSTRAINT "identity_group_applications_corporation_group_fk" FOREIGN KEY ("corporation_id", "group_id") REFERENCES "identity_groups"("corporation_id", "id") ON DELETE CASCADE;
      ALTER TABLE "identity_group_applications" ADD CONSTRAINT "identity_group_applications_corporation_user_fk" FOREIGN KEY ("corporation_id", "user_id") REFERENCES "corporation_memberships"("corporation_id", "user_id") ON DELETE CASCADE;
      ALTER TABLE "identity_group_applications" ADD CONSTRAINT "identity_group_applications_corporation_character_fk" FOREIGN KEY ("corporation_id", "character_id") REFERENCES "characters"("corporation_id", "id") ON DELETE RESTRICT;

      CREATE TABLE "identity_group_memberships" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "group_id" integer NOT NULL REFERENCES "identity_groups"("id") ON DELETE CASCADE,
        "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
        "character_id" integer REFERENCES "characters"("id") ON DELETE SET NULL,
        "granted_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "identity_group_memberships_group_user_unique" ON "identity_group_memberships" ("corporation_id", "group_id", "user_id");
      ALTER TABLE "identity_group_memberships" ADD CONSTRAINT "identity_group_memberships_corporation_group_fk" FOREIGN KEY ("corporation_id", "group_id") REFERENCES "identity_groups"("corporation_id", "id") ON DELETE CASCADE;
      ALTER TABLE "identity_group_memberships" ADD CONSTRAINT "identity_group_memberships_corporation_user_fk" FOREIGN KEY ("corporation_id", "user_id") REFERENCES "corporation_memberships"("corporation_id", "user_id") ON DELETE CASCADE;
      ALTER TABLE "identity_group_memberships" ADD CONSTRAINT "identity_group_memberships_corporation_character_fk" FOREIGN KEY ("corporation_id", "character_id") REFERENCES "characters"("corporation_id", "id") ON DELETE RESTRICT;

      INSERT INTO "identity_groups" ("corporation_id", "name", "category", "description", "required_skills", "permissions")
      SELECT c."id", seed."name", seed."category", seed."description", seed."required_skills"::jsonb, seed."permissions"::jsonb
      FROM "corporations" c
      CROSS JOIN (VALUES
        ('黑隐组', 'combat', '黑隐与隐秘行动能力认证', '[{"skillId":28656,"name":"Black Ops","level":4},{"skillId":11579,"name":"Cloaking","level":4},{"skillId":21611,"name":"Jump Drive Calibration","level":4}]', '[]'),
        ('旗舰组', 'combat', '旗舰驾驶与作战能力认证', '[{"skillId":20533,"name":"Capital Ships","level":4},{"skillId":3456,"name":"Jump Drive Operation","level":5},{"skillId":21611,"name":"Jump Drive Calibration","level":4},{"skillId":21610,"name":"Jump Fuel Conservation","level":4}]', '[]'),
        ('招新组', 'management', '军团招新与申请管理', '[]', '["recruitment.manage"]'),
        ('FC组', 'management', '舰队创建与指挥管理', '[]', '["fleet.manage"]'),
        ('外交组', 'management', '处理军团外交问题', '[]', '["diplomacy.manage"]'),
        ('补损审核组', 'management', '审核及记录舰船补损', '[]', '["reimbursement.manage"]'),
        ('总监组', 'management', '军团总监专属管理权限', '[]', '["economy.view","economy.manage","diplomacy.manage","reimbursement.manage","identity.manage"]')
      ) AS seed("name", "category", "description", "required_skills", "permissions")
      WHERE c."is_primary" = true;

      INSERT INTO "identity_group_memberships" ("corporation_id", "group_id", "user_id", "granted_by")
      SELECT g."corporation_id", g."id", u."id", u."id"
      FROM "identity_groups" g
      JOIN "users" u ON u."corporation_id" = g."corporation_id"
      WHERE g."name" = '总监组' AND u."role" = 'controller'
      ON CONFLICT DO NOTHING;

      CREATE TABLE "diplomacy_cases" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "submitted_by" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "submitter_character_id" integer NOT NULL,
        "submitter_name" text NOT NULL,
        "category" text NOT NULL CHECK ("category" IN ('standings', 'conflict', 'cooperation', 'compensation', 'complaint', 'other')),
        "counterparty" text NOT NULL,
        "subject" text NOT NULL,
        "description" text NOT NULL,
        "evidence_url" text,
        "urgency" text NOT NULL DEFAULT 'normal' CHECK ("urgency" IN ('normal', 'high', 'urgent')),
        "status" text NOT NULL DEFAULT 'submitted' CHECK ("status" IN ('submitted', 'accepted', 'investigating', 'waiting', 'resolved', 'rejected', 'closed')),
        "internal_notes" text,
        "assigned_to" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "diplomacy_cases_corporation_idx" ON "diplomacy_cases" ("corporation_id", "created_at" DESC);
      ALTER TABLE "diplomacy_cases" ADD CONSTRAINT "diplomacy_cases_corporation_user_fk" FOREIGN KEY ("corporation_id", "submitted_by") REFERENCES "corporation_memberships"("corporation_id", "user_id") ON DELETE RESTRICT;

      CREATE TABLE "reimbursement_claims" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "submitted_by" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "character_id" integer NOT NULL,
        "character_name" text NOT NULL,
        "fleet_id" integer REFERENCES "fleets"("id") ON DELETE RESTRICT,
        "killmail_id" integer NOT NULL,
        "killmail_hash" text NOT NULL,
        "killmail_url" text NOT NULL,
        "loss_occurred_at" timestamptz NOT NULL,
        "ship_type_id" integer NOT NULL,
        "ship_name" text NOT NULL,
        "loss_value" double precision NOT NULL DEFAULT 0 CHECK ("loss_value" >= 0),
        "requested_amount" double precision NOT NULL CHECK ("requested_amount" >= 0),
        "approved_amount" double precision CHECK ("approved_amount" IS NULL OR "approved_amount" >= 0),
        "description" text NOT NULL,
        "validation" jsonb NOT NULL,
        "status" text NOT NULL DEFAULT 'submitted' CHECK ("status" IN ('submitted', 'reviewing', 'approved', 'partially_approved', 'rejected', 'pending_payment', 'paid')),
        "reviewer_notes" text,
        "payment_reference" text,
        "reviewed_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "reviewed_at" timestamptz,
        "paid_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "reimbursement_claims_corporation_killmail_unique" ON "reimbursement_claims" ("corporation_id", "killmail_id");
      CREATE INDEX "reimbursement_claims_corporation_idx" ON "reimbursement_claims" ("corporation_id", "created_at" DESC);
      ALTER TABLE "reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_corporation_user_fk" FOREIGN KEY ("corporation_id", "submitted_by") REFERENCES "corporation_memberships"("corporation_id", "user_id") ON DELETE RESTRICT;
      ALTER TABLE "reimbursement_claims" ADD CONSTRAINT "reimbursement_claims_corporation_fleet_fk" FOREIGN KEY ("corporation_id", "fleet_id") REFERENCES "fleets"("corporation_id", "id") ON DELETE RESTRICT;

      CREATE TABLE "corporation_wallet_connections" (
        "corporation_id" integer PRIMARY KEY REFERENCES "corporations"("id") ON DELETE CASCADE,
        "character_id" integer NOT NULL,
        "connected_by" integer NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
        "access_token" text NOT NULL,
        "refresh_token" text NOT NULL,
        "token_expiry" timestamptz NOT NULL,
        "status" text NOT NULL DEFAULT 'connected' CHECK ("status" IN ('connected', 'error')),
        "last_error" text,
        "last_synced_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE "corporation_wallet_entries" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "division" integer NOT NULL CHECK ("division" BETWEEN 1 AND 7),
        "ref_id" text NOT NULL,
        "ref_type" text NOT NULL,
        "amount" double precision NOT NULL,
        "balance" double precision,
        "first_party_id" text,
        "second_party_id" text,
        "reason" text,
        "occurred_at" timestamptz NOT NULL,
        "raw" jsonb NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "corporation_wallet_entries_corporation_division_ref_unique" ON "corporation_wallet_entries" ("corporation_id", "division", "ref_id");
      CREATE INDEX "corporation_wallet_entries_corporation_date_idx" ON "corporation_wallet_entries" ("corporation_id", "occurred_at" DESC);

      CREATE TABLE "corporation_wallet_balances" (
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "division" integer NOT NULL CHECK ("division" BETWEEN 1 AND 7),
        "balance" double precision NOT NULL,
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "corporation_wallet_balances_corporation_division_unique" ON "corporation_wallet_balances" ("corporation_id", "division");

      CREATE TABLE "economy_analyses" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "period_start" timestamptz NOT NULL,
        "period_end" timestamptz NOT NULL,
        "source" text NOT NULL CHECK ("source" IN ('openai', 'rules')),
        "model" text NOT NULL,
        "analysis" jsonb NOT NULL,
        "created_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX "economy_analyses_corporation_idx" ON "economy_analyses" ("corporation_id", "created_at" DESC);
    `);
  },
};
