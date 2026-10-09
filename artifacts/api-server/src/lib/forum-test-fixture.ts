import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import * as schema from "@workspace/db/schema";
import type { db } from "@workspace/db";
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { memberForumMigration } from "../../../../lib/db/src/migrations/0034-member-forum";
import { createForumService } from "./forum-service";
import { createForumRouter, forumErrorHandler } from "./forum-router";
import type { ForumActor } from "./forum-rules";

export const forumActors: Record<number, ForumActor> = {
  1: { corporationId: 1001, userId: 1, userName: "测试管理员", role: "admin" },
  2: { corporationId: 1001, userId: 2, userName: "成员甲", role: "member" },
  3: { corporationId: 1001, userId: 3, userName: "成员乙", role: "member" },
  4: { corporationId: 2002, userId: 4, userName: "外军团管理员", role: "admin" },
  5: { corporationId: 1001, userId: 5, userName: "测试 FC", role: "fc" },
  6: { corporationId: 1001, userId: 6, userName: "测试总监", role: "controller" },
};
export async function createForumFixture(options: { defaultUser?: number; logQuery?: (query: string) => void } = {}) {
  const pg = new PGlite();
  await pg.exec(`CREATE TABLE corporations(id integer PRIMARY KEY); CREATE TABLE users(id integer PRIMARY KEY, eve_character_name text, redeemable_pap double precision NOT NULL DEFAULT 7.5); INSERT INTO corporations VALUES(1001),(2002); INSERT INTO users(id,eve_character_name) VALUES(1,'测试管理员'),(2,'成员甲'),(3,'成员乙'),(4,'外军团管理员'),(5,'测试 FC'),(6,'测试总监');`);
  const migrate = () => memberForumMigration.up({ query: (query: string) => pg.exec(query) } as unknown as Parameters<typeof memberForumMigration.up>[0]);
  await migrate();
  const database = drizzle(pg, { schema, logger: options.logQuery ? { logQuery: query => options.logQuery!(query) } : undefined }) as unknown as typeof db;
  const service = createForumService({ database });
  const auth: RequestHandler = (req, res, next) => {
    const current = forumActors[Number(req.headers["x-test-user"] ?? options.defaultUser ?? 0)];
    if (!current) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (req.headers["x-test-tenant-invalid"] === "true") { res.status(403).json({ error: "Forbidden" }); return; }
    req.tenant = { user: { id: current.userId, eveCharacterName: current.userName }, corporation: { id: current.corporationId }, membership: { role: current.role }, actorCharacter: { eveCharacterName: current.userName }, permissions: [] } as unknown as NonNullable<typeof req.tenant>;
    next();
  };
  const app = express(); app.use(express.json({ limit: "100kb" })); app.use("/api", createForumRouter({ service, requireAuth: auth, requireTenant: (_req, _res, next) => next() })); app.use("/api/forum", forumErrorHandler);
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, user = 2, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/forum${path}`, { method, headers: { "x-test-user": String(user), ...(Buffer.isBuffer(body) ? { "content-type": "text/plain", "x-file-name": "fixture.txt" } : { "content-type": "application/json" }), ...headers }, ...(body !== undefined ? { body: Buffer.isBuffer(body) ? body : JSON.stringify(body) } : {}) });
  return { pg, database, service, app, server, origin, request, migrate, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await pg.close(); } };
}
