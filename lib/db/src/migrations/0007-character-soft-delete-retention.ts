import type { PoolClient } from "pg";

export const characterSoftDeleteRetentionMigration = {
  id: "0007_character_soft_delete_retention",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "characters"
        ALTER COLUMN "user_id" DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS "deleted_at" timestamp with time zone,
        ADD COLUMN IF NOT EXISTS "retained_until" timestamp with time zone;

      CREATE INDEX IF NOT EXISTS "characters_active_user_id_idx"
        ON "characters" ("user_id")
        WHERE "deleted_at" IS NULL;

      CREATE INDEX IF NOT EXISTS "characters_active_eve_character_id_idx"
        ON "characters" ("eve_character_id")
        WHERE "deleted_at" IS NULL;

      CREATE INDEX IF NOT EXISTS "characters_deleted_retained_until_idx"
        ON "characters" ("retained_until")
        WHERE "deleted_at" IS NOT NULL;
    `);
  },
};
