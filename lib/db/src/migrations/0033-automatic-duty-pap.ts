import type { PoolClient } from "pg";

/** Additive only: no rules, authorizations, PAP currencies or balances seeded. */
export const automaticDutyPapMigration = {
  id: "0033_automatic_duty_pap",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS duty_pap_rules (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT,
        name text NOT NULL, eve_fleet_id text NOT NULL, currency_id integer,
        minutes_per_award integer NOT NULL, award_amount numeric(16,6) NOT NULL, daily_cap numeric(16,6) NOT NULL,
        solar_system_ids jsonb NOT NULL DEFAULT '[]'::jsonb, ship_type_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
        require_undocked boolean NOT NULL DEFAULT true, enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0,
        create_request_id text NOT NULL, created_by integer REFERENCES users(id) ON DELETE SET NULL, updated_by integer REFERENCES users(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT duty_pap_rules_currency_fk FOREIGN KEY (corporation_id,currency_id) REFERENCES pap_currencies(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT duty_pap_rules_values_valid CHECK (minutes_per_award BETWEEN 1 AND 1440 AND award_amount > 0 AND award_amount <= 1000000 AND daily_cap >= award_amount AND daily_cap <= 1000000 AND version >= 0),
        CONSTRAINT duty_pap_rules_text_valid CHECK (length(name) BETWEEN 1 AND 80 AND eve_fleet_id ~ '^[1-9][0-9]{0,15}$')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duty_pap_rules_corp_id_unique ON duty_pap_rules(corporation_id,id);
      CREATE UNIQUE INDEX IF NOT EXISTS duty_pap_rules_request_unique ON duty_pap_rules(corporation_id,create_request_id);
      CREATE UNIQUE INDEX IF NOT EXISTS duty_pap_rules_active_fleet_unique ON duty_pap_rules(corporation_id,eve_fleet_id) WHERE enabled = true;

      CREATE TABLE IF NOT EXISTS duty_pap_connections (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT, user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        character_id integer NOT NULL, access_token text, refresh_token text, token_expiry timestamptz, scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
        enabled boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 0, context_changed_at timestamptz NOT NULL DEFAULT now(),
        last_observed_at timestamptz, last_eligible_rule_id integer, last_eligible_rule_version integer,
        last_status text NOT NULL DEFAULT 'authorization_required', status_message text NOT NULL DEFAULT '尚未授权值守采集。',
        last_fleet_id text, last_solar_system_id integer, last_ship_type_id integer, last_checked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT duty_pap_connections_character_fk FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE,
        CONSTRAINT duty_pap_connections_version_valid CHECK (version >= 0)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duty_pap_connections_owner_unique ON duty_pap_connections(corporation_id,user_id);
      CREATE UNIQUE INDEX IF NOT EXISTS duty_pap_connections_corp_id_unique ON duty_pap_connections(corporation_id,id);

      CREATE TABLE IF NOT EXISTS duty_pap_progress (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT, rule_id integer NOT NULL,
        user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE, day text NOT NULL, rule_version integer NOT NULL,
        eligible_seconds integer NOT NULL DEFAULT 0, total_eligible_seconds integer NOT NULL DEFAULT 0, award_count integer NOT NULL DEFAULT 0, paid_amount numeric(16,6) NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT duty_pap_progress_rule_fk FOREIGN KEY (corporation_id,rule_id) REFERENCES duty_pap_rules(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT duty_pap_progress_values_valid CHECK (eligible_seconds >= 0 AND total_eligible_seconds >= 0 AND award_count >= 0 AND paid_amount >= 0 AND rule_version >= 0 AND day ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duty_pap_progress_period_unique ON duty_pap_progress(corporation_id,rule_id,user_id,day);

      CREATE TABLE IF NOT EXISTS duty_pap_awards (
        id serial PRIMARY KEY, corporation_id integer NOT NULL REFERENCES corporations(id) ON DELETE RESTRICT, rule_id integer NOT NULL,
        user_id integer REFERENCES users(id) ON DELETE SET NULL, user_name text NOT NULL, character_name text NOT NULL,
        day text NOT NULL, award_index integer NOT NULL, rule_version integer NOT NULL, rule_name text NOT NULL, eve_fleet_id text NOT NULL, minutes_per_award integer NOT NULL,
        amount numeric(16,6) NOT NULL, currency_id integer, currency_name text NOT NULL, pap_record_id integer REFERENCES pap_records(id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT duty_pap_awards_rule_fk FOREIGN KEY (corporation_id,rule_id) REFERENCES duty_pap_rules(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT duty_pap_awards_currency_fk FOREIGN KEY (corporation_id,currency_id) REFERENCES pap_currencies(corporation_id,id) ON DELETE RESTRICT,
        CONSTRAINT duty_pap_awards_values_valid CHECK (award_index > 0 AND rule_version >= 0 AND amount > 0 AND minutes_per_award BETWEEN 1 AND 1440)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS duty_pap_awards_period_unique ON duty_pap_awards(corporation_id,rule_id,user_id,day,award_index);
      CREATE INDEX IF NOT EXISTS duty_pap_awards_member_idx ON duty_pap_awards(corporation_id,user_id,id);
    `);
  },
};
