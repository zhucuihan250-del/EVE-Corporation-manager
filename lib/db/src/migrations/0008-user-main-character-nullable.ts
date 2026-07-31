import type { PoolClient } from "pg";

export const userMainCharacterNullableMigration = {
  id: "0008_user_main_character_nullable",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE "users"
        ALTER COLUMN "eve_character_id" DROP NOT NULL,
        ALTER COLUMN "eve_character_name" DROP NOT NULL,
        ALTER COLUMN "corporation_id" DROP NOT NULL,
        ALTER COLUMN "corporation_name" DROP NOT NULL,
        ALTER COLUMN "corporation_joined_at" DROP NOT NULL,
        ALTER COLUMN "access_token" DROP NOT NULL,
        ALTER COLUMN "refresh_token" DROP NOT NULL,
        ALTER COLUMN "token_expiry" DROP NOT NULL;
    `);
  },
};
