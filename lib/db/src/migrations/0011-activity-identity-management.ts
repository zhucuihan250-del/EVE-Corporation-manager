import type { PoolClient } from "pg";

export const activityIdentityManagementMigration = {
  id: "0011_activity_identity_management",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "corporations"
        ADD COLUMN "activity_minimum_pap" double precision NOT NULL DEFAULT 2
        CHECK ("activity_minimum_pap" >= 0 AND "activity_minimum_pap" <= 1000);

      CREATE TABLE "corporation_skill_plans" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "name" text NOT NULL,
        "description" text NOT NULL DEFAULT '',
        "required_skills" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "is_active" boolean NOT NULL DEFAULT true,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "corporation_skill_plans_corporation_name_unique"
        ON "corporation_skill_plans" ("corporation_id", "name");
      CREATE UNIQUE INDEX "corporation_skill_plans_corporation_id_unique"
        ON "corporation_skill_plans" ("corporation_id", "id");

      ALTER TABLE "identity_groups"
        ADD COLUMN "skill_plan_match_mode" text NOT NULL DEFAULT 'all'
        CHECK ("skill_plan_match_mode" IN ('all', 'any'));

      CREATE TABLE "identity_group_skill_plans" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "group_id" integer NOT NULL REFERENCES "identity_groups"("id") ON DELETE CASCADE,
        "skill_plan_id" integer NOT NULL REFERENCES "corporation_skill_plans"("id") ON DELETE CASCADE,
        "created_at" timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX "identity_group_skill_plans_group_plan_unique"
        ON "identity_group_skill_plans" ("corporation_id", "group_id", "skill_plan_id");
      ALTER TABLE "identity_group_skill_plans"
        ADD CONSTRAINT "identity_group_skill_plans_corporation_group_fk"
        FOREIGN KEY ("corporation_id", "group_id")
        REFERENCES "identity_groups"("corporation_id", "id") ON DELETE CASCADE;
      ALTER TABLE "identity_group_skill_plans"
        ADD CONSTRAINT "identity_group_skill_plans_corporation_plan_fk"
        FOREIGN KEY ("corporation_id", "skill_plan_id")
        REFERENCES "corporation_skill_plans"("corporation_id", "id") ON DELETE CASCADE;

      INSERT INTO "corporation_skill_plans" (
        "corporation_id", "name", "description", "required_skills"
      )
      SELECT
        g."corporation_id",
        g."name" || '默认技能方案',
        '由现有身份组技能要求自动迁移',
        g."required_skills"
      FROM "identity_groups" g
      WHERE jsonb_array_length(g."required_skills") > 0;

      INSERT INTO "identity_group_skill_plans" (
        "corporation_id", "group_id", "skill_plan_id"
      )
      SELECT g."corporation_id", g."id", p."id"
      FROM "identity_groups" g
      JOIN "corporation_skill_plans" p
        ON p."corporation_id" = g."corporation_id"
       AND p."name" = g."name" || '默认技能方案'
      ON CONFLICT DO NOTHING;

      UPDATE "identity_groups"
      SET "skill_plan_match_mode" = 'any'
      WHERE "name" = '黑隐组';

      UPDATE "identity_groups"
      SET "permissions" = "permissions" || '["activity.manage"]'::jsonb
      WHERE "name" = '总监组'
        AND NOT ("permissions" @> '["activity.manage"]'::jsonb);

      UPDATE "identity_groups"
      SET "permissions" = "permissions" || '["fleet.manage"]'::jsonb
      WHERE "name" = 'FC组'
        AND NOT ("permissions" @> '["fleet.manage"]'::jsonb);
    `);
  },
};
