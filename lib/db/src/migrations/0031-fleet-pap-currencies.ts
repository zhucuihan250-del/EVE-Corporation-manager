import type { PoolClient } from "pg";

/** No balances or award history are rewritten; null currency retains common PAP. */
export const fleetPapCurrenciesMigration = {
  id: "0031_fleet_pap_currencies",
  async up(client: PoolClient): Promise<void> {
    await client.query(`
      ALTER TABLE fleets ADD COLUMN IF NOT EXISTS pap_currency_id integer REFERENCES pap_currencies(id) ON DELETE RESTRICT;
      ALTER TABLE fleets ADD COLUMN IF NOT EXISTS pap_currency_name text;
      ALTER TABLE pap_records ADD COLUMN IF NOT EXISTS currency_id integer REFERENCES pap_currencies(id) ON DELETE RESTRICT;
      ALTER TABLE pap_records ADD COLUMN IF NOT EXISTS currency_name text;
      -- Widen storage without rounding or normalizing existing fleet values.
      ALTER TABLE fleets ALTER COLUMN pap_value TYPE double precision USING pap_value::double precision;
      CREATE INDEX IF NOT EXISTS pap_records_fleet_character_currency_idx ON pap_records(fleet_id, character_id, currency_id);
    `);
  },
};
