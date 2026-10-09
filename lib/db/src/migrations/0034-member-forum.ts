import type { PoolClient } from "pg";

/** Additive only: creates empty forum tables without changing business data. */
export const memberForumMigration = {
  id: "0034_member_forum",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS forum_posts (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        author_user_id integer REFERENCES users(id) ON DELETE SET NULL, author_name text NOT NULL,
        title text NOT NULL, body text NOT NULL, pinned boolean NOT NULL DEFAULT false, locked boolean NOT NULL DEFAULT false,
        version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
        CONSTRAINT forum_posts_text_valid CHECK (length(title) BETWEEN 1 AND 150 AND length(body) <= 20000 AND length(author_name) BETWEEN 1 AND 200),
        CONSTRAINT forum_posts_version_valid CHECK (version >= 1)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS forum_posts_corp_id_unique ON forum_posts(corporation_id,id);
      CREATE INDEX IF NOT EXISTS forum_posts_listing_idx ON forum_posts(corporation_id,pinned,created_at,id);
      CREATE TABLE IF NOT EXISTS forum_replies (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT, post_id integer NOT NULL,
        author_user_id integer REFERENCES users(id) ON DELETE SET NULL, author_name text NOT NULL, body text NOT NULL,
        version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
        CONSTRAINT forum_replies_post_fk FOREIGN KEY(corporation_id,post_id) REFERENCES forum_posts(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT forum_replies_text_valid CHECK (length(body) BETWEEN 1 AND 20000 AND length(author_name) BETWEEN 1 AND 200),
        CONSTRAINT forum_replies_version_valid CHECK (version >= 1)
      );
      CREATE INDEX IF NOT EXISTS forum_replies_post_idx ON forum_replies(corporation_id,post_id,id);
      CREATE TABLE IF NOT EXISTS forum_attachments (
        id uuid PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        owner_user_id integer REFERENCES users(id) ON DELETE SET NULL, post_id integer,
        file_name text NOT NULL, mime_type text NOT NULL, size integer NOT NULL, data_base64 text,
        created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz,
        CONSTRAINT forum_attachments_post_fk FOREIGN KEY(corporation_id,post_id) REFERENCES forum_posts(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT forum_attachments_values_valid CHECK (size BETWEEN 1 AND 5242880 AND length(file_name) BETWEEN 1 AND 180 AND mime_type IN ('image/png','image/jpeg','image/gif','image/webp','application/pdf','text/plain') AND ((deleted_at IS NULL AND data_base64 IS NOT NULL AND length(data_base64) = 4 * ((size + 2) / 3)) OR (deleted_at IS NOT NULL AND data_base64 IS NULL)))
      );
      CREATE INDEX IF NOT EXISTS forum_attachments_owner_idx ON forum_attachments(corporation_id,owner_user_id,created_at);
      CREATE INDEX IF NOT EXISTS forum_attachments_post_idx ON forum_attachments(corporation_id,post_id);
    `);
  },
};
