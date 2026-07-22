import type { PoolClient } from "pg";

export const battleReportReviewsMigration = {
  id: "0005_battle_report_reviews",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS "battle_report_reviews" (
        "id" serial PRIMARY KEY,
        "battle_report_id" integer NOT NULL UNIQUE REFERENCES "battle_reports"("id") ON DELETE CASCADE,
        "status" text NOT NULL DEFAULT 'draft',
        "ai_status" text NOT NULL DEFAULT 'not_started',
        "ai_source" text,
        "ai_model" text,
        "ai_error" text,
        "ai_analysis" jsonb,
        "manual_nodes" jsonb NOT NULL DEFAULT '[]'::jsonb,
        "conclusion" text NOT NULL DEFAULT '',
        "updated_by" integer REFERENCES "users"("id") ON DELETE SET NULL,
        "ai_analyzed_at" timestamp with time zone,
        "published_at" timestamp with time zone,
        "created_at" timestamp with time zone NOT NULL DEFAULT now(),
        "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
        CONSTRAINT "battle_report_reviews_status_valid"
          CHECK ("status" IN ('draft', 'published')),
        CONSTRAINT "battle_report_reviews_ai_status_valid"
          CHECK ("ai_status" IN ('not_started', 'generating', 'ready', 'failed')),
        CONSTRAINT "battle_report_reviews_ai_source_valid"
          CHECK ("ai_source" IS NULL OR "ai_source" IN ('openai', 'rules'))
      );

      CREATE INDEX IF NOT EXISTS "battle_report_reviews_status_idx"
        ON "battle_report_reviews" ("status", "updated_at" DESC);
    `);
  },
};
