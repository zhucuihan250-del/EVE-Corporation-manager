// Test-only module. Never imported by runtime routes or the production entry.
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { buybackCalculatorMigration } from "../../../../lib/db/src/migrations/0029-buyback-calculator";
import { createBuybackService, type BuybackActor, type BuybackServiceDependencies } from "./buyback-service";
import { createBuybackRouter } from "./buyback-router";
import type { BuybackCatalogTarget, BuybackCatalogType } from "./buyback-catalog";

export const BUYBACK_FIXTURE_ACTORS: Record<number, BuybackActor> = {
  1: { corporationId: 1001, userId: 1, userName: "测试管理员", role: "admin" },
  2: { corporationId: 1001, userId: 2, userName: "测试成员", role: "member" },
  3: { corporationId: 1001, userId: 3, userName: "另一成员", role: "member" },
  4: { corporationId: 2002, userId: 4, userName: "历史军团管理员", role: "admin" },
  5: { corporationId: 1001, userId: 5, userName: "测试 FC", role: "fc" },
};

export const BUYBACK_FIXTURE_TYPES: BuybackCatalogType[] = [
  { typeId: 34, name: "Tritanium", categoryId: 4, categoryName: "Material", marketGroupId: 18 },
  { typeId: 35, name: "Pyerite", categoryId: 4, categoryName: "Material", marketGroupId: 18 },
  { typeId: 11289, name: "Cap Booster 800", categoryId: 8, categoryName: "Charge", marketGroupId: 19 },
  { typeId: 2048, name: "Damage Control II Blueprint", categoryId: 9, categoryName: "Blueprint", marketGroupId: 20 },
];

export async function createBuybackFixture(options: Partial<Omit<BuybackServiceDependencies, "database">> & {
  defaultActor?: number;
  searchCatalog?: (query: string, kind: "category" | "type") => Promise<BuybackCatalogTarget[]>;
} = {}) {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE corporations (id integer PRIMARY KEY);
    CREATE TABLE users (id integer PRIMARY KEY);
    INSERT INTO corporations VALUES (1001), (2002);
    INSERT INTO users VALUES (1), (2), (3), (4), (5);
  `);
  const runMigration = () => buybackCalculatorMigration.up({ query: (sql: string) => pg.exec(sql) } as unknown as Parameters<typeof buybackCalculatorMigration.up>[0]);
  await runMigration();
  const dependencies: BuybackServiceDependencies = {
    // PGlite executes the same PostgreSQL queries and transaction callbacks; its
    // driver type differs, but production still supplies the node-pg database.
    database: drizzle(pg) as unknown as BuybackServiceDependencies["database"],
    resolveTypes: options.resolveTypes ?? (async names => new Map(names.flatMap(name => {
      const item = BUYBACK_FIXTURE_TYPES.find(type => type.name === name);
      return item ? [[name, item] as const] : [];
    }))),
    getTarget: options.getTarget ?? (async (scope, id) => {
      if (scope === "category") return [4, 8, 9].includes(id) ? { id, name: `Category ${id}` } : null;
      const item = BUYBACK_FIXTURE_TYPES.find(type => type.typeId === id);
      return item ? { id, name: item.name } : null;
    }),
    getPrices: options.getPrices ?? (async ids => new Map(ids.map(id => [id, { buy: "10.00", sell: "12.00", updatedAt: new Date().toISOString() }]))),
  };
  const service = createBuybackService(dependencies);
  const app = express();
  app.use("/api/buyback/quotes", express.json({ limit: "400kb" }));
  app.use(express.json());
  const authenticate: RequestHandler = (req, res, next) => {
    // Headers/cookies only exist in this test-only server; no equivalent is
    // wired into production. Use 0 to test the unauthenticated boundary.
    const cookieActor = req.headers.cookie?.match(/(?:^|;\s*)buyback_test_user=(\d+)(?:;|$)/)?.[1];
    const selected = req.headers["x-test-user"] ?? cookieActor ?? options.defaultActor ?? 2;
    const actor = BUYBACK_FIXTURE_ACTORS[Number(selected)];
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    req.tenant = {
      user: { id: actor.userId, eveCharacterName: actor.userName },
      corporation: { id: actor.corporationId }, membership: { role: actor.role }, permissions: [], actorCharacter: null,
    } as unknown as NonNullable<typeof req.tenant>;
    next();
  };
  app.use("/api", createBuybackRouter({
    service, requireAuth: authenticate, requireTenant: (_req, _res, next) => next(),
    searchCatalog: options.searchCatalog ?? (async (query, kind) => kind === "category"
      ? [4, 8, 9].map(id => ({ id, name: `Category ${id}` }))
      : BUYBACK_FIXTURE_TYPES.filter(type => type.name.toLowerCase().includes(query.toLowerCase())).map(type => ({ id: type.typeId, name: type.name }))),
  }));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : "Fixture failure" });
  });
  return {
    pg, service, app, runMigration,
    createService: () => createBuybackService(dependencies),
    async listen(port = 0) {
      const server = app.listen(port, "127.0.0.1");
      await new Promise<void>(resolve => server.once("listening", resolve));
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
    },
    close: () => pg.close(),
  };
}
