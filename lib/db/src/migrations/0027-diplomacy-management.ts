import type { PoolClient } from "pg";

export const diplomacyManagementMigration = {
  id: "0027_diplomacy_management",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "diplomacy_cases"
        ADD COLUMN "public_reply" text,
        ADD COLUMN "assigned_name" text,
        ADD COLUMN "resolved_at" timestamptz,
        ADD COLUMN "closed_at" timestamptz;

      CREATE UNIQUE INDEX "diplomacy_cases_corporation_id_unique"
        ON "diplomacy_cases" ("corporation_id", "id");
      CREATE INDEX "diplomacy_cases_corporation_status_idx"
        ON "diplomacy_cases" ("corporation_id", "status", "updated_at" DESC);

      CREATE TABLE "diplomacy_case_events" (
        "id" serial PRIMARY KEY,
        "corporation_id" integer NOT NULL REFERENCES "corporations"("id") ON DELETE CASCADE,
        "case_id" integer NOT NULL,
        "actor_user_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "actor_name" text NOT NULL,
        "event_type" text NOT NULL CHECK ("event_type" IN ('submitted', 'assigned', 'unassigned', 'status_changed', 'public_reply', 'internal_note')),
        "visibility" text NOT NULL DEFAULT 'public' CHECK ("visibility" IN ('public', 'internal')),
        "from_status" text,
        "to_status" text,
        "message" text,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "diplomacy_case_events_corporation_case_fk"
          FOREIGN KEY ("corporation_id", "case_id")
          REFERENCES "diplomacy_cases"("corporation_id", "id") ON DELETE CASCADE
      );
      CREATE INDEX "diplomacy_case_events_corporation_case_time_idx"
        ON "diplomacy_case_events" ("corporation_id", "case_id", "created_at" DESC);
    `);
  },
};
