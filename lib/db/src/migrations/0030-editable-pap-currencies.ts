import type { PoolClient } from "pg";

/** Additive currency tables only. Existing balances and business records are untouched. */
export const editablePapCurrenciesMigration = {
  id: "0030_editable_pap_currencies",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS pap_currencies (
        id serial PRIMARY KEY,
        corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        name text NOT NULL, normalized_name text NOT NULL, description text NOT NULL DEFAULT '',
        rate numeric(13,6) NOT NULL,
        issuance_enabled boolean NOT NULL DEFAULT true, conversion_enabled boolean NOT NULL DEFAULT true,
        version integer NOT NULL DEFAULT 0, create_request_id text NOT NULL,
        created_by integer REFERENCES users(id) ON DELETE SET NULL,
        updated_by integer REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pap_currencies_rate_valid CHECK(rate > 0 AND rate <= 1000000),
        CONSTRAINT pap_currencies_version_valid CHECK(version >= 0),
        CONSTRAINT pap_currencies_name_valid CHECK(length(name) BETWEEN 1 AND 40 AND length(description) <= 1000)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pap_currencies_corporation_id_unique ON pap_currencies(corporation_id,id);
      CREATE UNIQUE INDEX IF NOT EXISTS pap_currencies_name_unique ON pap_currencies(corporation_id,normalized_name);
      CREATE UNIQUE INDEX IF NOT EXISTS pap_currencies_create_request_unique ON pap_currencies(corporation_id,create_request_id);
      CREATE TABLE IF NOT EXISTS pap_currency_wallets (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        currency_id integer NOT NULL, user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        balance numeric(16,6) NOT NULL DEFAULT 0, carry numeric(13,12) NOT NULL DEFAULT 0,
        version integer NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pap_currency_wallets_currency_fk FOREIGN KEY(corporation_id,currency_id) REFERENCES pap_currencies(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT pap_currency_wallets_balance_valid CHECK(balance >= 0 AND balance <= 1000000000),
        CONSTRAINT pap_currency_wallets_carry_valid CHECK(carry >= 0 AND carry < 0.000001),
        CONSTRAINT pap_currency_wallets_version_valid CHECK(version >= 0)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pap_currency_wallets_owner_unique ON pap_currency_wallets(corporation_id,currency_id,user_id);
      CREATE INDEX IF NOT EXISTS pap_currency_wallets_member_idx ON pap_currency_wallets(corporation_id,user_id);
      CREATE TABLE IF NOT EXISTS pap_currency_ledger (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        currency_id integer NOT NULL, currency_name text NOT NULL, currency_version integer NOT NULL,
        user_id integer REFERENCES users(id) ON DELETE SET NULL, user_name text NOT NULL, type text NOT NULL,
        amount numeric(16,6) NOT NULL, rate numeric(13,6), common_amount numeric(16,6) NOT NULL DEFAULT 0,
        balance_before numeric(16,6) NOT NULL, balance_after numeric(16,6) NOT NULL,
        carry_before numeric(13,12) NOT NULL, carry_after numeric(13,12) NOT NULL,
        common_balance_before numeric(16,6), common_balance_after numeric(16,6),
        request_id text, request_fingerprint text, reason text NOT NULL, fleet_id integer, character_id integer,
        admin_id integer REFERENCES users(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pap_currency_ledger_currency_fk FOREIGN KEY(corporation_id,currency_id) REFERENCES pap_currencies(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT pap_currency_ledger_type_valid CHECK(type IN ('award','adjustment','conversion','account_merge')),
        CONSTRAINT pap_currency_ledger_balances_valid CHECK(balance_before >= 0 AND balance_after >= 0 AND balance_before <= 1000000000 AND balance_after <= 1000000000 AND common_amount >= 0 AND common_amount <= 1000000000),
        CONSTRAINT pap_currency_ledger_carry_valid CHECK(carry_before >= 0 AND carry_before < 0.000001 AND carry_after >= 0 AND carry_after < 0.000001)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS pap_currency_ledger_request_unique ON pap_currency_ledger(corporation_id,request_id);
      CREATE INDEX IF NOT EXISTS pap_currency_ledger_member_idx ON pap_currency_ledger(corporation_id,user_id,created_at);
      ALTER TABLE pap_ledger DROP CONSTRAINT IF EXISTS pap_ledger_type_check;
      ALTER TABLE pap_ledger ADD CONSTRAINT pap_ledger_type_check CHECK(type IN ('opening_balance','pap_earned','pap_conversion','redemption','admin_adjustment','activity_deduction','account_merge','market_order_lock','market_order_unlock','market_transaction_lock','market_transaction_unlock','market_buy','market_sell','reversal'));
      CREATE OR REPLACE FUNCTION preserve_pap_currency_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (to_jsonb(NEW) - 'user_id' - 'admin_id') IS DISTINCT FROM (to_jsonb(OLD) - 'user_id' - 'admin_id')
          OR (NEW.user_id IS DISTINCT FROM OLD.user_id AND NEW.user_id IS NOT NULL)
          OR (NEW.admin_id IS DISTINCT FROM OLD.admin_id AND NEW.admin_id IS NOT NULL) THEN
          RAISE EXCEPTION 'PAP currency ledger snapshots are immutable' USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
      END; $$;
      DROP TRIGGER IF EXISTS pap_currency_ledger_immutable ON pap_currency_ledger;
      CREATE TRIGGER pap_currency_ledger_immutable BEFORE UPDATE ON pap_currency_ledger FOR EACH ROW EXECUTE FUNCTION preserve_pap_currency_ledger();
    `);
  },
};
