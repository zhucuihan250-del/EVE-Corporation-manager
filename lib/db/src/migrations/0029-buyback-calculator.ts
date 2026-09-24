import type { PoolClient } from "pg";

/** Additive only: no existing business records are rewritten or removed. */
export const buybackCalculatorMigration = {
  id: "0029_buyback_calculator",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS buyback_settings (
        corporation_id integer PRIMARY KEY REFERENCES corporations(id) ON DELETE RESTRICT,
        enabled boolean NOT NULL DEFAULT false,
        default_enabled boolean NOT NULL DEFAULT true,
        price_basis text NOT NULL DEFAULT 'buy',
        rate_percent numeric(6,2) NOT NULL DEFAULT 100.00,
        fixed_price numeric(18,2),
        quote_validity_minutes integer NOT NULL DEFAULT 30,
        version integer NOT NULL DEFAULT 0,
        updated_by integer REFERENCES users(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT buyback_settings_basis_check CHECK (price_basis IN ('buy','sell','mid','fixed')),
        CONSTRAINT buyback_settings_rate_check CHECK (rate_percent >= 0.01 AND rate_percent <= 1000),
        CONSTRAINT buyback_settings_fixed_check CHECK (fixed_price IS NULL OR (fixed_price > 0 AND fixed_price <= 1000000000000000)),
        CONSTRAINT buyback_settings_fixed_required CHECK (price_basis <> 'fixed' OR fixed_price IS NOT NULL),
        CONSTRAINT buyback_settings_validity_check CHECK (quote_validity_minutes BETWEEN 1 AND 1440),
        CONSTRAINT buyback_settings_version_check CHECK (version >= 0)
      );
      CREATE TABLE IF NOT EXISTS buyback_rules (
        id serial PRIMARY KEY,
        corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        scope text NOT NULL,
        target_id integer NOT NULL,
        target_name text NOT NULL,
        enabled boolean,
        price_basis text,
        rate_percent numeric(6,2),
        fixed_price numeric(18,2),
        updated_by integer REFERENCES users(id) ON DELETE SET NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT buyback_rules_scope_check CHECK (scope IN ('category','type')),
        CONSTRAINT buyback_rules_target_check CHECK (target_id > 0),
        CONSTRAINT buyback_rules_basis_check CHECK (price_basis IS NULL OR price_basis IN ('buy','sell','mid','fixed')),
        CONSTRAINT buyback_rules_rate_check CHECK (rate_percent IS NULL OR (rate_percent >= 0.01 AND rate_percent <= 1000)),
        CONSTRAINT buyback_rules_fixed_check CHECK (fixed_price IS NULL OR (fixed_price > 0 AND fixed_price <= 1000000000000000))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS buyback_rules_target_unique ON buyback_rules(corporation_id, scope, target_id);
      CREATE TABLE IF NOT EXISTS buyback_quotes (
        id serial PRIMARY KEY,
        corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        submitted_by integer REFERENCES users(id) ON DELETE SET NULL,
        submitter_name text NOT NULL,
        input_text text NOT NULL,
        request_id text NOT NULL,
        total_isk numeric(22,2) NOT NULL,
        complete boolean NOT NULL,
        settings_version integer NOT NULL,
        settings_snapshot jsonb NOT NULL,
        rules_snapshot jsonb NOT NULL,
        lines jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        CONSTRAINT buyback_quotes_total_check CHECK (total_isk >= 0 AND total_isk <= 999999999999999999.99),
        CONSTRAINT buyback_quotes_expiry_check CHECK (expires_at > created_at),
        CONSTRAINT buyback_quotes_lines_check CHECK (jsonb_typeof(lines) = 'array'),
        CONSTRAINT buyback_quotes_line_count_check CHECK (jsonb_array_length(lines) BETWEEN 1 AND 200),
        CONSTRAINT buyback_quotes_input_length_check CHECK (length(input_text) BETWEEN 1 AND 100000),
        CONSTRAINT buyback_quotes_version_check CHECK (settings_version >= 0),
        CONSTRAINT buyback_quotes_request_check CHECK (request_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS buyback_quotes_request_unique ON buyback_quotes(corporation_id, submitted_by, request_id);
      CREATE INDEX IF NOT EXISTS buyback_quotes_member_created_idx ON buyback_quotes(corporation_id, submitted_by, created_at);
      CREATE INDEX IF NOT EXISTS buyback_quotes_corporation_created_idx ON buyback_quotes(corporation_id, created_at);
      -- Saved amounts, price/rule snapshots and expiration never change. The
      -- existing user-retention workflow may still null a deleted user link.
      CREATE OR REPLACE FUNCTION preserve_buyback_quote_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (to_jsonb(NEW) - 'submitted_by') IS DISTINCT FROM (to_jsonb(OLD) - 'submitted_by')
          OR (NEW.submitted_by IS DISTINCT FROM OLD.submitted_by AND NEW.submitted_by IS NOT NULL) THEN
          RAISE EXCEPTION 'Saved buyback quote snapshots are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END;
      $$;
      DROP TRIGGER IF EXISTS buyback_quote_snapshot_immutable ON buyback_quotes;
      CREATE TRIGGER buyback_quote_snapshot_immutable BEFORE UPDATE ON buyback_quotes
        FOR EACH ROW EXECUTE FUNCTION preserve_buyback_quote_snapshot();
    `);
  },
};
