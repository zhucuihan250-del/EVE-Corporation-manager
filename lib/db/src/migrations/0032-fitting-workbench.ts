import type { PoolClient } from "pg";

/** Additive only: no existing fitting, character or PAP data is rewritten. */
export const fittingWorkbenchMigration = {
  id: "0032_fitting_workbench",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS fittings (
        id serial PRIMARY KEY,
        corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE CASCADE,
        visibility text NOT NULL,
        owner_user_id integer REFERENCES users(id) ON DELETE CASCADE,
        created_by integer REFERENCES users(id) ON DELETE SET NULL,
        updated_by integer REFERENCES users(id) ON DELETE SET NULL,
        author_name text NOT NULL,
        name text NOT NULL,
        description text NOT NULL DEFAULT '',
        fit jsonb NOT NULL,
        simulation jsonb NOT NULL,
        version integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT fittings_visibility_owner_check CHECK ((visibility='personal' AND owner_user_id IS NOT NULL) OR (visibility='corporation' AND owner_user_id IS NULL)),
        CONSTRAINT fittings_version_check CHECK (version >= 1),
        CONSTRAINT fittings_text_lengths_check CHECK (char_length(name) BETWEEN 1 AND 100 AND char_length(description) <= 2000 AND char_length(author_name) BETWEEN 1 AND 200),
        CONSTRAINT fittings_payload_check CHECK (jsonb_typeof(fit)='object' AND coalesce(fit->>'schemaVersion'='2',false) AND jsonb_typeof(simulation)='object')
      );
      CREATE INDEX IF NOT EXISTS fittings_corporation_visibility_owner_id_idx ON fittings(corporation_id,visibility,owner_user_id,id);
    `);
  },
};
