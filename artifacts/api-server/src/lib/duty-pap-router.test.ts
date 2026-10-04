import assert from "node:assert/strict";
import test from "node:test";
import express, { type RequestHandler } from "express";
import type { AddressInfo } from "node:net";
import { createDutyPapRouter } from "./duty-pap-router";
import { DutyPapError, dutyPapId, type DutyPapActor } from "./duty-pap-rules";
import { PapCurrencyError } from "./pap-currency-math";

const actors: Record<number, DutyPapActor> = {
  1: { corporationId: 1001, userId: 1, userName: "管理员", role: "admin" },
  2: { corporationId: 1001, userId: 2, userName: "成员", role: "member" },
  3: { corporationId: 1001, userId: 3, userName: "FC", role: "fc" },
  4: { corporationId: 2002, userId: 4, userName: "外军团管理员", role: "admin" },
  5: { corporationId: 1001, userId: 5, userName: "总监", role: "controller" },
};
async function fixture(options: { papEnabled?: boolean; fleetEnabled?: boolean } = {}) {
  const calls: { action: string; actor: DutyPapActor; value?: unknown }[] = [];
  let failure: unknown;
  const invoke = (action: string, actor: DutyPapActor, value?: unknown) => {
    calls.push({ action, actor, value }); if (failure) throw failure;
    return { action, corporationId: actor.corporationId, userId: actor.userId };
  };
  const service = {
    memberDashboard: async (actor: DutyPapActor) => invoke("member", actor),
    adminDashboard: async (actor: DutyPapActor) => invoke("admin", actor),
    setConnectionEnabled: async (actor: DutyPapActor, value: unknown) => invoke("connection", actor, value),
    createRule: async (actor: DutyPapActor, value: unknown) => invoke("create", actor, value),
    updateRule: async (actor: DutyPapActor, id: number, value: unknown) => {
      dutyPapId(id); if (id === 1 && actor.corporationId !== 1001) throw new DutyPapError(404, "DUTY_PAP_RULE_NOT_FOUND", "找不到本军团的该规则。");
      return invoke("update", actor, { id, body: value });
    },
  } as unknown as Parameters<typeof createDutyPapRouter>[0]["service"];
  const auth: RequestHandler = (req, res, next) => {
    const id = Number(req.headers["x-test-user"]); const actor = actors[id];
    if (!actor) { res.status(401).json({ error: "Unauthorized" }); return; }
    if (req.headers["x-test-tenant-invalid"] === "true") { res.status(403).json({ error: "Forbidden" }); return; }
    req.tenant = { user: { id: actor.userId, eveCharacterName: actor.userName }, corporation: { id: actor.corporationId }, membership: { role: actor.role } } as unknown as NonNullable<typeof req.tenant>;
    next();
  };
  const enabled = (flag: boolean | undefined): RequestHandler => (_req, res, next) => {
    if (flag === false) { res.status(404).json({ error: "Module not available" }); return; } next();
  };
  const app = express(); app.use(express.json({ limit: "40kb" }));
  app.use("/api", createDutyPapRouter({ service, requireAuth: auth, requireTenant: (_req, _res, next) => next(), requirePap: enabled(options.papEnabled), requireFleet: enabled(options.fleetEnabled) }));
  const server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, user = 2, method = "GET", body?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api${path}`, { method, headers: { "x-test-user": String(user), "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  return { calls, request, fail: (error: unknown) => { failure = error; }, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test("HTTP duty reads and writes require authentication, a valid tenant and both enabled modules", async () => {
  const f = await fixture();
  try {
    for (const [path, method, body] of [["/duty-pap", "GET", undefined], ["/admin/duty-pap", "GET", undefined], ["/duty-pap/connection", "POST", { enabled: true, version: 0 }], ["/admin/duty-pap/rules", "POST", {}]] as const) {
      assert.equal((await f.request(path, 0, method, body)).status, 401);
      assert.equal((await f.request(path, 1, method, body, { "x-test-tenant-invalid": "true" })).status, 403);
    }
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
  for (const options of [{ papEnabled: false }, { fleetEnabled: false }]) {
    const unavailable = await fixture(options);
    try {
      for (const [path, method, body] of [["/duty-pap", "GET", undefined], ["/admin/duty-pap", "GET", undefined], ["/duty-pap/connection", "POST", {}], ["/admin/duty-pap/rules", "POST", {}]] as const) {
        assert.equal((await unavailable.request(path, 1, method, body)).status, 404);
      }
      assert.equal(unavailable.calls.length, 0);
    } finally { await unavailable.close(); }
  }
});

test("only admin/controller can manage automatic rules; member/FC cannot access administration or manually trigger credits", async () => {
  const f = await fixture();
  try {
    for (const user of [2, 3]) {
      assert.equal((await f.request("/duty-pap", user)).status, 200);
      for (const [path, method] of [["/admin/duty-pap", "GET"], ["/admin/duty-pap/rules", "POST"], ["/admin/duty-pap/rules/1", "PUT"]]) {
        assert.equal((await f.request(path, user, method, method === "GET" ? undefined : {})).status, 403);
      }
    }
    for (const user of [1, 5]) {
      assert.equal((await f.request("/admin/duty-pap", user)).status, 200);
      assert.equal((await f.request("/admin/duty-pap/rules", user, "POST", {})).status, 201);
      assert.equal((await f.request("/admin/duty-pap/rules/1", user, "PUT", {})).status, 200);
    }
    for (const path of ["/duty-pap/observe", "/duty-pap/award", "/admin/duty-pap/scan", "/admin/duty-pap/award"]) assert.equal((await f.request(path, 1, "POST", {})).status, 404);
    assert.equal((await f.request("/admin/duty-pap/rules/1", 1, "DELETE")).status, 404);
  } finally { await f.close(); }
});

test("router derives actor and corporation from validated session context, not supplied body, query or headers", async () => {
  const f = await fixture();
  try {
    const foreign = await f.request("/duty-pap?userId=2&corporationId=1001", 4, "GET", undefined, { "x-corporation-id": "1001", "x-user-id": "2" });
    assert.deepEqual(await foreign.json(), { action: "member", corporationId: 2002, userId: 4 });
    assert.equal((await f.request("/admin/duty-pap/rules/1", 4, "PUT", { userId: 1, corporationId: 1001 })).status, 404);
    await f.request("/duty-pap/connection", 2, "POST", { enabled: false, version: 0, userId: 1, corporationId: 2002 });
    const connection = f.calls.find(call => call.action === "connection")!;
    assert.equal(connection.actor.userId, 2); assert.equal(connection.actor.corporationId, 1001); assert.equal(connection.actor.role, "member");
    assert.equal(f.calls.some(call => call.action === "update" && call.actor.userId === 4), false);
  } finally { await f.close(); }
});

test("unknown upstream/SQL errors never expose token, database details or raw bodies; typed errors remain useful", async () => {
  const f = await fixture();
  try {
    const secret = "DO_NOT_LEAK_TOKEN_OR_DATABASE_FIXTURE";
    for (const error of [new Error(secret), { code: "23503", detail: secret }, { cause: { code: "42P01", query: secret } }]) {
      f.fail(error); const response = await f.request("/duty-pap"); assert.equal(response.status, 503);
      const body = await response.text(); assert.ok(body.includes("DUTY_PAP_UNAVAILABLE")); assert.ok(!body.includes(secret));
    }
    f.fail({ cause: { code: "23505", detail: secret } }); const conflict = await f.request("/admin/duty-pap/rules", 1, "POST", {});
    assert.equal(conflict.status, 409); assert.equal((await conflict.json() as { code: string }).code, "DUTY_PAP_CONFLICT");
    f.fail(new DutyPapError(409, "DUTY_PAP_VERSION_CONFLICT", "规则已经变化，请刷新。"));
    assert.deepEqual(await (await f.request("/admin/duty-pap", 1)).json(), { error: "规则已经变化，请刷新。", code: "DUTY_PAP_VERSION_CONFLICT" });
    f.fail(new PapCurrencyError(409, "PAP_ISSUANCE_PAUSED", "该 PAP 已暂停发放。"));
    assert.equal((await f.request("/admin/duty-pap", 1)).status, 409);
  } finally { await f.close(); }
});

test("invalid route ids and oversized bodies fail safely before service mutation", async () => {
  const f = await fixture();
  try {
    for (const id of ["1x", "1.5", "0", "-1", "2147483648"]) assert.equal((await f.request(`/admin/duty-pap/rules/${id}`, 1, "PUT", {})).status, 400);
    const response = await f.request("/admin/duty-pap/rules", 1, "POST", { name: "x".repeat(17000) }); assert.equal(response.status, 413);
    assert.equal((await response.json() as { code: string }).code, "DUTY_PAP_PAYLOAD_LIMIT");
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("read/write rate limits are independent and scoped per corporation/account", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 120; i++) assert.equal((await f.request("/duty-pap", 2)).status, 200);
    assert.equal((await f.request("/duty-pap", 2)).status, 429);
    assert.equal((await f.request("/duty-pap", 1)).status, 200);
    for (let i = 0; i < 30; i++) assert.equal((await f.request("/duty-pap/connection", 2, "POST", { enabled: false, version: i })).status, 200);
    assert.equal((await f.request("/duty-pap/connection", 2, "POST", {})).status, 429);
  } finally { await f.close(); }
});
