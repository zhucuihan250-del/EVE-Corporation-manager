// Test-only real router and engine with a temporary PostgreSQL-compatible DB.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express, { type IRouter, type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { fittingWorkbenchMigration } from "../../../../lib/db/src/migrations/0032-fitting-workbench";
import { exportEft, FittingInputError, parseEft, resolveWorkbenchFit, simulateWorkbench, validateCanonicalFit } from "./fitting-engine";
import { getFittingCatalogItem, searchFittingCatalog } from "./fitting-data";
import { createFittingWorkbenchService } from "./fitting-workbench-service";
import { createFittingWorkbenchRouter, fittingWorkbenchErrorHandler } from "./fitting-workbench-router";
import { createFittingSkillsService, type fetchFittingSkills } from "./fitting-workbench-skills";
import type { FittingActor } from "./fitting-workbench-errors";
import type { CanonicalFit } from "./fitting-engine-types";
import type { refreshSkillTokens } from "./identity-skills-client";
import { createFittingAdviceService } from "./fitting-advice-service";
import { adviceError, type FittingAdviceProvider } from "./fitting-advice-provider";
import type { FittingAdvicePrice } from "./fitting-advice-types";

export const FITTING_FIXTURE_ACTORS: Record<number, FittingActor> = {
  1: { corporationId: 1001, userId: 1, userName: "测试管理员", role: "admin", permissions: [] },
  2: { corporationId: 1001, userId: 2, userName: "测试成员", role: "member", permissions: [] },
  3: { corporationId: 1001, userId: 3, userName: "另一成员", role: "member", permissions: [] },
  4: { corporationId: 2002, userId: 4, userName: "外军团管理员", role: "admin", permissions: [] },
  5: { corporationId: 1001, userId: 5, userName: "测试 FC", role: "fc", permissions: [] },
  6: { corporationId: 1001, userId: 6, userName: "舰队管理组成员", role: "member", permissions: ["fleet.manage"] },
};
export function fittingFixtureInput(overrides: Partial<CanonicalFit> = {}): CanonicalFit {
  return { schemaVersion: 2, shipTypeId: 593, name: "Tristan Test", slots: [], drones: [], cargo: [], skillProfile: { mode: "all5" }, damageProfile: { em: 0.25, thermal: 0.25, kinetic: 0.25, explosive: 0.25 }, ...overrides };
}
export async function createFittingWorkbenchFixture(options: { defaultActor?: number; fleetEnabled?: boolean; fetchSkills?: typeof fetchFittingSkills; refreshTokens?: typeof refreshSkillTokens; logQuery?: (query: string) => void; extraRouterFactory?: (guards: RequestHandler[]) => IRouter; adviceProvider?: FittingAdviceProvider; adviceQuotes?: (fits: CanonicalFit[]) => Promise<FittingAdvicePrice[]>; adviceLimits?: Parameters<typeof createFittingAdviceService>[0]["limits"] } = {}) {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE corporations(id integer PRIMARY KEY);
    CREATE TABLE users(id serial PRIMARY KEY,eve_character_id integer,eve_character_name text,corporation_id integer,corporation_name text,corporation_joined_at timestamptz,access_token text,refresh_token text,token_expiry timestamptz,role text NOT NULL DEFAULT 'member',total_pap double precision NOT NULL DEFAULT 0,redeemable_pap double precision NOT NULL DEFAULT 0,locked_pap double precision NOT NULL DEFAULT 0,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE characters(id serial PRIMARY KEY,user_id integer REFERENCES users(id),eve_character_id integer NOT NULL,eve_character_name text NOT NULL,corporation_id integer,corporation_name text,access_token text,refresh_token text,token_expiry timestamptz,is_main boolean NOT NULL DEFAULT false,deleted_at timestamptz,retained_until timestamptz,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now());
    ALTER TABLE characters ADD COLUMN membership_status text NOT NULL DEFAULT 'unknown', ADD COLUMN actual_corporation_id integer,
      ADD COLUMN membership_checked_at timestamptz, ADD COLUMN corporation_left_at timestamptz,
      ADD COLUMN membership_retained_until timestamptz, ADD COLUMN retention_corporation_id integer;
    INSERT INTO corporations VALUES(1001),(2002);
    INSERT INTO users(id,eve_character_name,corporation_id,total_pap,redeemable_pap) VALUES(1,'测试管理员',1001,15,15),(2,'测试成员',1001,12,12),(3,'另一成员',1001,0,0),(4,'外军团管理员',2002,7,7),(5,'测试 FC',1001,1,1),(6,'舰队管理组成员',1001,1,1);
    INSERT INTO characters(id,user_id,eve_character_id,eve_character_name,corporation_id,access_token,refresh_token,token_expiry,is_main,deleted_at) VALUES
      (20,2,90000002,'测试成员',1001,'fixture-access','fixture-refresh',now()+interval '1 hour',true,NULL),
      (21,2,90000021,'成员小号',1001,'fixture-alt-access','fixture-alt-refresh',now()+interval '1 hour',false,NULL),
      (22,2,90000022,'已解绑角色',1001,'fixture-deleted-access','fixture-deleted-refresh',now()+interval '1 hour',false,now()),
      (23,2,90000023,'军团外角色',2002,'fixture-foreign-access','fixture-foreign-refresh',now()+interval '1 hour',false,NULL),
      (30,3,90000003,'另一成员',1001,'fixture-other-access','fixture-other-refresh',now()+interval '1 hour',true,NULL),
      (40,4,90000004,'外军团管理员',2002,'fixture-foreign-access','fixture-foreign-refresh',now()+interval '1 hour',true,NULL);
  `);
  const runMigration = () => fittingWorkbenchMigration.up({ query: (statement: string) => pg.exec(statement) } as unknown as Parameters<typeof fittingWorkbenchMigration.up>[0]);
  await runMigration();
  const database = drizzle(pg, { logger: options.logQuery ? { logQuery: query => options.logQuery!(query) } : false }) as unknown as Parameters<typeof createFittingWorkbenchService>[0]["database"];
  const skills = createFittingSkillsService({ database, fetchSkills: options.fetchSkills ?? (async () => [{ skillId: 3426, activeLevel: 3, trainedLevel: 5 }, { skillId: 3436, activeLevel: 2, trainedLevel: 4 }]), refreshTokens: options.refreshTokens });
  const service = createFittingWorkbenchService({ database, engine: { validateCanonicalFit, resolveWorkbenchFit, simulateWorkbench, parseEft, exportEft }, skills });
  const adviceService = createFittingAdviceService({ engine: { validateCanonicalFit, simulateWorkbench, exportEft }, resolveSkills: service.resolveSkillContext,
    provider: options.adviceProvider ?? { isConfigured: () => false, generate: async () => { throw adviceError("FITTING_AI_NOT_CONFIGURED"); } },
    quoteFits: options.adviceQuotes ?? (async fits => fits.map(() => ({ estimatedTotalIsk: null, complete: false, basis: "jita_sell" as const, checkedAt: new Date().toISOString(), missingTypeIds: [], note: "Fixture does not call public market services." }))),
    limits: options.adviceLimits,
  });
  const app = express();
  app.use(express.json({ limit: "100kb" }));
  const authenticate: RequestHandler = (req, res, next) => {
    const cookie = req.headers.cookie?.match(/(?:^|;\s*)fitting_test_user=(\d+)(?:;|$)/)?.[1];
    const actor = FITTING_FIXTURE_ACTORS[Number(req.headers["x-test-user"] ?? cookie ?? options.defaultActor ?? 2)];
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.tenant = { user: { id: actor.userId, eveCharacterName: actor.userName }, corporation: { id: actor.corporationId }, membership: { role: actor.role }, permissions: actor.permissions, actorCharacter: null } as unknown as NonNullable<typeof req.tenant>;
    next();
  };
  const requireFixtureFleet: RequestHandler = (_req, res, next) => {
    if (options.fleetEnabled === false) { res.status(404).json({ error: "Module not available" }); return; }
    next();
  };
  if (options.extraRouterFactory) app.use("/api", options.extraRouterFactory([authenticate, requireFixtureFleet]));
  // Local UI acceptance uses this synthetic identity; production never imports
  // the fixture and no genuine EVE login or account balance is used here.
  app.get("/api/auth/me", authenticate, (req, res) => {
    const actor = req.tenant!;
    res.json({ id: actor.user.id, eveCharacterId: 90000000 + actor.user.id, eveCharacterName: actor.user.eveCharacterName, corporationId: actor.corporation.id, corporationName: "Local fitting QA corporation", role: actor.membership.role, permissions: actor.permissions, isPrimaryCorporation: actor.corporation.id === 1001, tacticalGroups: [], reimbursementOpen: true, modules: { fleet: options.fleetEnabled !== false, pap: true, identity: false, economy: false, reimbursement: false, diplomacy: false, courier: false, structures: false }, pap: 0, totalPap: 0, redeemablePap: 0, availablePap: 0, lockedPap: 0, createdAt: new Date().toISOString() });
  });
  app.use("/api", createFittingWorkbenchRouter({ service, adviceService, requireAuth: authenticate, requireTenant: (_req, _res, next) => next(), requireFleet: requireFixtureFleet, searchCatalog: searchFittingCatalog, getCatalogItem: getFittingCatalogItem, isEngineInputError: (error): error is FittingInputError => error instanceof FittingInputError }));
  app.use("/api/fitting", fittingWorkbenchErrorHandler);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number }).status === 413 ? 413 : 500;
    res.status(status).json({ error: status === 413 ? "Payload too large" : "Fixture failure" });
  });
  return { pg, database, skills, service, adviceService, app, runMigration, close: () => pg.close(), async listen(port = 0) {
    const server = app.listen(port, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
  } };
}
