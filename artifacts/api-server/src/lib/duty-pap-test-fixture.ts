// Isolated PostgreSQL-compatible test fixture. Never imported in production.
import { randomUUID } from "node:crypto";
import { automaticDutyPapMigration } from "../../../../lib/db/src/migrations/0033-automatic-duty-pap";
import { createPapCurrencyFixture, PAP_FIXTURE_ACTORS } from "./pap-currency-test-fixture";
import { createDutyPapService } from "./duty-pap-service";
import { DUTY_PAP_SCOPES } from "./duty-pap-rules";
import type { DutyPapObservation } from "./duty-pap-collector";

export { PAP_FIXTURE_ACTORS as DUTY_ACTORS };
export const dutyRuleInput = (extra: Record<string, unknown> = {}) => ({ name: "外部 FC 的认可值守舰队", eveFleetId: "1099522222222", currencyId: null, awardAmount: "0.1", minutesPerAward: 1, dailyCap: "0.25", solarSystemIds: [], shipTypeIds: [], requireUndocked: true, enabled: false, requestId: randomUUID(), ...extra });
export async function createDutyPapFixture() {
  const base = await createPapCurrencyFixture();
  await base.pg.exec(`
    ALTER TABLE corporations ADD COLUMN is_primary boolean NOT NULL DEFAULT false, ADD COLUMN is_active boolean NOT NULL DEFAULT true, ADD COLUMN pap_enabled boolean NOT NULL DEFAULT true, ADD COLUMN fleet_enabled boolean NOT NULL DEFAULT true;
    UPDATE corporations SET is_primary=true WHERE id=1001;
    CREATE TABLE characters(id serial PRIMARY KEY,user_id integer REFERENCES users(id) ON DELETE CASCADE,eve_character_id integer NOT NULL,eve_character_name text NOT NULL,corporation_id integer REFERENCES corporations(id) ON DELETE SET NULL,corporation_name text,access_token text,refresh_token text,token_expiry timestamptz,is_main boolean NOT NULL DEFAULT false,deleted_at timestamptz,retained_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE pap_records(id serial PRIMARY KEY,corporation_id integer NOT NULL REFERENCES corporations(id),user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,character_id integer REFERENCES characters(id) ON DELETE SET NULL,fleet_id integer,amount double precision NOT NULL,currency_id integer REFERENCES pap_currencies(id),currency_name text,type text NOT NULL,reason text,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO characters(id,user_id,eve_character_id,eve_character_name,corporation_id,access_token,refresh_token) VALUES(10,2,20010,'值守角色一',1001,'existing-skill-access','existing-skill-refresh'),(11,2,20011,'值守角色二',1001,'other-skill-access','other-skill-refresh'),(12,3,20012,'另一成员',1001,'existing-member-access','existing-member-refresh'),(20,4,20020,'外部军团角色',2002,'foreign-access','foreign-refresh');
  `);
  const runMigration = () => automaticDutyPapMigration.up({ query: (statement: string) => base.pg.exec(statement) } as unknown as Parameters<typeof automaticDutyPapMigration.up>[0]);
  await runMigration();
  let instant = new Date("2026-10-04T10:00:00Z");
  const service = createDutyPapService({ database: base.database, now: () => new Date(instant), configuredCorporationId: "" });
  const setTime = (value: Date | string | number) => { instant = new Date(value); };
  const advance = (seconds: number) => { instant = new Date(instant.getTime() + seconds * 1000); };
  const authorize = async (userId = 2, characterId = 10, expectedVersion: number | null = null) => service.authorizeConnection(PAP_FIXTURE_ACTORS[userId]!, { characterId, accessToken: "duty-access-only", refreshToken: "duty-refresh-only", tokenExpiry: new Date(instant.getTime() + 3_600_000), scopes: [...DUTY_PAP_SCOPES], expectedVersion });
  const createRule = async (extra: Record<string, unknown> = {}, actor = PAP_FIXTURE_ACTORS[1]!) => {
    const body = dutyRuleInput(extra), { rule } = await service.createRule(actor, body);
    return (await service.updateRule(actor, rule!.id, { ...body, enabled: true, version: rule!.version })).rule!;
  };
  const observation = (extra: Partial<DutyPapObservation> = {}): DutyPapObservation => ({ observedAt: new Date(instant), evidenceAt: new Date(instant), valid: true, status: "observed", eveFleetId: "1099522222222", corporationId: 1001, online: true, solarSystemId: 30000142, shipTypeId: 587, docked: false, ...extra });
  const connection = async (userId = 2) => (await base.pg.query<{ id: number; version: number }>("SELECT id,version FROM duty_pap_connections WHERE corporation_id=1001 AND user_id=$1", [userId])).rows[0]!;
  const sample = async (extra: Partial<DutyPapObservation> = {}, userId = 2) => { const row = await connection(userId); return service.processObservation(row.id, row.version, observation(extra)); };
  return { ...base, service, runDutyMigration: runMigration, setTime, advance, authorize, createRule, observation, connection, sample, now: () => new Date(instant) };
}
