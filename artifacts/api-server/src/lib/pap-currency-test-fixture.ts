// Test-only injectable HTTP app; never imported by production routes.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { editablePapCurrenciesMigration } from "../../../../lib/db/src/migrations/0030-editable-pap-currencies";
import { createPapCurrencyService, type PapCurrencyActor } from "./pap-currency-service";
import { createPapCurrencyRouter } from "./pap-currency-router";

export const PAP_FIXTURE_ACTORS: Record<number, PapCurrencyActor> = {
  1: { corporationId: 1001, userId: 1, userName: "测试管理员", role: "admin" },
  2: { corporationId: 1001, userId: 2, userName: "测试成员", role: "member" },
  3: { corporationId: 1001, userId: 3, userName: "另一成员", role: "member" },
  4: { corporationId: 2002, userId: 4, userName: "历史军团管理员", role: "admin" },
  5: { corporationId: 1001, userId: 5, userName: "测试 FC", role: "fc" },
};
export async function createPapCurrencyFixture(options: { defaultActor?: number; papEnabled?: boolean } = {}) {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE corporations(id integer PRIMARY KEY);
    CREATE TABLE users(id serial PRIMARY KEY,eve_character_id integer,eve_character_name text,corporation_id integer,corporation_name text,corporation_joined_at timestamptz,access_token text,refresh_token text,token_expiry timestamptz,role text NOT NULL DEFAULT 'member',total_pap double precision NOT NULL DEFAULT 0,redeemable_pap double precision NOT NULL DEFAULT 0,locked_pap double precision NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE corporation_memberships(id serial PRIMARY KEY,corporation_id integer NOT NULL,user_id integer NOT NULL,role text NOT NULL DEFAULT 'member',created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE pap_ledger(id serial PRIMARY KEY,corporation_id integer NOT NULL,user_id integer REFERENCES users(id) ON DELETE SET NULL,user_name text NOT NULL,amount double precision NOT NULL DEFAULT 0,locked_delta double precision NOT NULL DEFAULT 0,type text NOT NULL,order_id integer,transaction_id integer,balance_after double precision NOT NULL,locked_after double precision NOT NULL,available_after double precision NOT NULL,admin_id integer,reason text,created_at timestamptz NOT NULL DEFAULT now());
    INSERT INTO corporations VALUES(1001),(2002);
    INSERT INTO users(id,eve_character_name,corporation_id,total_pap,redeemable_pap,locked_pap) VALUES(1,'测试管理员',1001,15.25,15.25,0),(2,'测试成员',1001,12.5,12.5,2),(3,'另一成员',1001,0,0,0),(4,'历史军团管理员',2002,7,7,0),(5,'测试 FC',1001,1,1,0);
    INSERT INTO corporation_memberships(corporation_id,user_id,role) VALUES(1001,1,'admin'),(1001,2,'member'),(1001,3,'member'),(2002,4,'admin'),(1001,5,'fc');
  `);
  const runMigration = () => editablePapCurrenciesMigration.up({ query: (statement: string) => pg.exec(statement) } as unknown as Parameters<typeof editablePapCurrenciesMigration.up>[0]);
  await runMigration();
  const database = drizzle(pg) as unknown as Parameters<typeof createPapCurrencyService>[0]["database"];
  const service = createPapCurrencyService({ database }), app = express();
  app.use(express.json({ limit: "20kb" }));
  const authenticate: RequestHandler = (req, res, next) => {
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)pap_test_user=(\d+)(?:;|$)/)?.[1];
    const actor = PAP_FIXTURE_ACTORS[Number(req.headers["x-test-user"] ?? cookie ?? options.defaultActor ?? 2)];
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.tenant = { user: { id: actor.userId, eveCharacterName: actor.userName }, corporation: { id: actor.corporationId }, membership: { role: actor.role }, permissions: [], actorCharacter: null } as unknown as NonNullable<typeof req.tenant>;
    next();
  };
  app.use("/api", createPapCurrencyRouter({ service, requireAuth: authenticate, requireTenant: (_req, _res, next) => next(), requirePap: (_req, res, next) => {
    if (options.papEnabled === false) { res.status(404).json({ error: "Module not available" }); return; }
    next();
  } }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(500).json({ error: error instanceof Error ? error.message : "Fixture failure" }); });
  return { pg, database, service, app, runMigration, createService: () => createPapCurrencyService({ database }), close: () => pg.close(), async listen(port = 0) {
    const server = app.listen(port, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
  } };
}
