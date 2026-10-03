import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import express, { type Request, type RequestHandler } from "express";
import { createFittingModelRouter, FITTING_MODEL_ROUTE_LIMITS } from "./fitting-model-router";
import { FittingModelError, getFittingModel, validateFittingResourcePath } from "./fitting-models";
import { fittingWorkbenchErrorHandler } from "./fitting-workbench-router";
import { GetFittingModelMetadataResponse } from "../../../../lib/api-zod/src/generated/api";

type Adapters = NonNullable<Parameters<typeof createFittingModelRouter>[1]>;
const resource = "/api/fitting/3d/resources/3561556/dx9/model/ship.black";
const metadata = "/api/fitting/3d/model/593";
const tinyLimits = (changes: Partial<typeof FITTING_MODEL_ROUTE_LIMITS>) => ({ ...FITTING_MODEL_ROUTE_LIMITS, ...changes });

async function fixture(options: { adapters?: Adapters; auth?: boolean; tenant?: boolean; fleet?: boolean; mismatchedSession?: boolean; sessionOnly?: boolean } = {}) {
  const app = express(), calls = { model: 0, source: 0, resource: 0 }, guardOrder: string[] = [];
  const authenticate: RequestHandler = (req, res, next) => {
    guardOrder.push("auth");
    if (options.auth === false) { res.status(401).json({ error: "Fixture auth required" }); return; }
    const id = Number(req.headers["x-qa-user"] ?? 1);
    req.session = { userId: options.mismatchedSession ? id + 1 : id } as Request["session"];
    next();
  };
  const tenant: RequestHandler = (req, res, next) => {
    guardOrder.push("tenant");
    if (options.tenant === false || (req.headers["x-qa-corporation"] && req.headers["x-qa-corporation"] !== "1001")) { res.status(403).json({ error: "Fixture corporation required" }); return; }
    if (!options.sessionOnly) req.tenant = { user: { id: Number(req.headers["x-qa-user"] ?? 1) }, corporation: { id: 1001 } } as Request["tenant"];
    next();
  };
  const fleet: RequestHandler = (_req, res, next) => {
    guardOrder.push("fleet");
    if (options.fleet === false) { res.status(404).json({ error: "Fixture fleet disabled" }); return; }
    next();
  };
  const adapters = options.adapters ?? {};
  app.use("/api", createFittingModelRouter([authenticate, tenant, fleet], {
    ...adapters,
    getModel: (id, subsystemIds) => { calls.model++; return adapters.getModel?.(id, subsystemIds) ?? getFittingModel(id, subsystemIds); },
    getSource: async () => { calls.source++; return adapters.getSource?.() ?? { clientBuild: 3561556 }; },
    getResource: async (build, path) => { calls.resource++; return adapters.getResource?.(build, path) ?? { bytes: Buffer.from("abcd"), etag: '"fixture"' }; },
  }));
  app.use("/api/fitting", fittingWorkbenchErrorHandler);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, guardOrder, async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${url}${path}`, init), bytes = Buffer.from(await response.arrayBuffer());
    let body: Record<string, unknown> | undefined;
    try { body = JSON.parse(bytes.toString("utf8")); } catch { /* Resource body is binary. */ }
    return { response, bytes, body };
  }, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

test("3D resource allowlist rejects URLs, traversal, encodings and executable/account files", () => {
  assert.equal(validateFittingResourcePath("DX9/Model/Ship.BLACK"), "res:/dx9/model/ship.black");
  for (const value of ["https://127.0.0.1/private.black", "res:/dx9/model/ship.black", "dx9/../secret.black", "dx9/./ship.black", "dx9//ship.black", "dx9/%2e%2e/private.black", "dx9/model\\ship.black", "dx9/model/ship.js", "dx9/model/account.json", "dx9/model/ship.black?url=https://evil.invalid", `dx9/${"x".repeat(321)}.black`]) {
    assert.throws(() => validateFittingResourcePath(value), (error: unknown) => error instanceof FittingModelError && error.code === "FITTING_MODEL_INVALID_PATH", value);
  }
});

test("model metadata is SDE-backed and excludes non-ship inventory types", () => {
  const model = getFittingModel(593);
  assert.equal(model.typeId, 593);
  assert.ok(model.graphicId > 0 && model.dna && model.sdeBuildNumber > 0);
  for (const id of [450, 0, -1, 999999999]) assert.throws(() => getFittingModel(id), (error: unknown) => error instanceof FittingModelError && error.status === 404);
});

test("metadata and binary resources apply auth, tenant and fleet guards before any getter", async () => {
  for (const [options, status] of [[{ auth: false }, 401], [{ tenant: false }, 403], [{ fleet: false }, 404], [{ mismatchedSession: true }, 401], [{ sessionOnly: true }, 401]] as const) {
    const app = await fixture(options);
    try {
      for (const path of [metadata, resource]) assert.equal((await app.request(path)).response.status, status);
      if ("auth" in options && options.auth === false) for (const path of [metadata, resource]) assert.equal((await app.request(path, { headers: { "Sec-Fetch-Site": "cross-site" } })).response.status, 401);
      assert.deepEqual(app.calls, { model: 0, source: 0, resource: 0 });
    } finally { await app.close(); }
  }
  const app = await fixture();
  try {
    assert.equal((await app.request(metadata, { headers: { "x-qa-corporation": "2002" } })).response.status, 403);
    assert.deepEqual(app.guardOrder, ["auth", "tenant"]);
    assert.deepEqual(app.calls, { model: 0, source: 0, resource: 0 });
  } finally { await app.close(); }
  const hotlink = await fixture();
  try {
    for (const path of [metadata, resource]) {
      const result = await hotlink.request(path, { headers: { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" } });
      assert.equal(result.response.status, 403); assert.equal(result.body?.code, "FITTING_MODEL_CROSS_SITE_FORBIDDEN");
    }
    assert.deepEqual(hotlink.calls, { model: 0, source: 0, resource: 0 });
    for (const site of ["same-origin", "same-site", "none"]) assert.equal((await hotlink.request(resource, { headers: { "Sec-Fetch-Site": site } })).response.status, 200);
  } finally { await hotlink.close(); }
});

test("metadata/bootstrap accepts only bounded positive numeric IDs and a unique subsystem query", async () => {
  const app = await fixture();
  try {
    for (const suffix of ["0", "-1", "1e3", "2147483648", "999999999999999999999999"]) assert.equal((await app.request(`/api/fitting/3d/model/${suffix}`)).response.status, 400);
    for (const query of ["subsystems=1&subsystems=2", "subsystems=0", "subsystems=1,,2", "subsystems=1,1", "subsystems=1,2,3,4,5,6", "subsystems=-1", "subsystems=NaN", "subsystems=2147483648", "url=https://evil.invalid", "ownerUserId=2"]) assert.equal((await app.request(`${metadata}?${query}`)).response.status, 400, query);
    assert.deepEqual(app.calls, { model: 0, source: 0, resource: 0 });
    const accepted = await app.request(`${metadata}?subsystems=1,2`);
    assert.equal(accepted.response.status, 200);
    assert.equal(GetFittingModelMetadataResponse.safeParse(accepted.body).success, true, "Generated metadata contract must accept real route JSON");
    assert.equal(accepted.body?.resourceRoot, "/api/fitting/3d/resources/3561556/");
    assert.equal(accepted.response.headers.get("cache-control"), "private, no-cache");
    assert.equal(accepted.response.headers.get("x-content-type-options"), "nosniff");
    assert.ok(!accepted.bytes.toString("utf8").includes("token"));
  } finally { await app.close(); }
});

test("resource input validation runs before the source adapter and rejects query/path attacks", async () => {
  const app = await fixture();
  try {
    for (const path of ["/api/fitting/3d/model/%FF", "/api/fitting/3d/resources/0/dx9/model/ship.black", "/api/fitting/3d/resources/999999999999999999999999/dx9/model/ship.black", "/api/fitting/3d/resources/3561556/dx9/%FF/ship.black", "/api/fitting/3d/resources/3561556/dx9/%252e%252e/private.black", "/api/fitting/3d/resources/3561556/dx9/model/account.json", `${resource}?url=https://127.0.0.1/private`, `${resource}?ownerUserId=2`]) assert.equal((await app.request(path)).response.status, 400, path);
    assert.equal(app.calls.resource, 0);
    const result = await app.request(resource);
    assert.equal(result.response.status, 200);
    assert.equal(result.bytes.toString("utf8"), "abcd");
    assert.equal(result.response.headers.get("content-type"), "application/octet-stream");
    assert.equal(result.response.headers.get("cache-control"), "private, max-age=3600");
    assert.equal(result.response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(result.response.headers.get("etag"), '"fixture"');
    assert.equal((await app.request(resource.replace("ship.black", "ship.png"))).response.headers.get("content-type"), "image/png");
  } finally { await app.close(); }
});

test("cached responses count against the exact per-user byte budget and do not consume another user's budget", async () => {
  assert.equal(FITTING_MODEL_ROUTE_LIMITS.perUserBytes, 256 * 1024 * 1024);
  assert.equal(FITTING_MODEL_ROUTE_LIMITS.globalBytes, 512 * 1024 * 1024);
  const cached = { bytes: Buffer.from("abcd"), etag: '"cached"' };
  const app = await fixture({ adapters: { now: () => 0, getResource: async () => cached, limits: tinyLimits({ perUserBytes: 8, globalBytes: 24 }) } });
  try {
    for (let index = 0; index < 2; index++) assert.equal((await app.request(resource)).response.status, 200);
    const limited = await app.request(resource);
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body?.code, "FITTING_MODEL_USER_BYTE_LIMIT");
    assert.equal(limited.response.headers.get("retry-after"), "60");
    assert.equal((await app.request(resource, { headers: { "x-qa-user": "2" } })).response.status, 200);
  } finally { await app.close(); }
});

test("global response byte budget spans users and is restored only after the full minute window", async () => {
  let clock = 0;
  const app = await fixture({ adapters: { now: () => clock, limits: tinyLimits({ perUserBytes: 8, globalBytes: 12 }) } });
  try {
    for (const user of [1, 2, 3]) assert.equal((await app.request(resource, { headers: { "x-qa-user": String(user) } })).response.status, 200);
    let limited = await app.request(resource, { headers: { "x-qa-user": "4" } });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.body?.code, "FITTING_MODEL_GLOBAL_BYTE_LIMIT");
    clock = 59_999;
    limited = await app.request(resource, { headers: { "x-qa-user": "4" } });
    assert.equal(limited.response.status, 429);
    assert.equal(limited.response.headers.get("retry-after"), "1");
    clock = 60_000;
    assert.equal((await app.request(resource, { headers: { "x-qa-user": "4" } })).response.status, 200);
  } finally { await app.close(); }
});

test("concurrent cached responses reserve budgets atomically", async () => {
  let release: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const app = await fixture({ adapters: { limits: tinyLimits({ perUserBytes: 4, globalBytes: 4 }), getResource: async () => { if (++calls === 2) release(); await barrier; return { bytes: Buffer.from("abcd"), etag: '"cached"' }; } } });
  try {
    const results = await Promise.all([app.request(resource), app.request(resource)]);
    assert.deepEqual(results.map(result => result.response.status).sort(), [200, 429]);
    assert.equal(results.filter(result => result.response.status === 200).reduce((total, result) => total + result.bytes.byteLength, 0), 4);
  } finally { await app.close(); }
});

test("HEAD and genuine ETag 304 have no byte charge but remain request-rate limited", async () => {
  const app = await fixture({ adapters: { limits: tinyLimits({ perUserBytes: 4, globalBytes: 4, requests: 8 }) } });
  try {
    for (let index = 0; index < 2; index++) {
      const head = await app.request(resource, { method: "HEAD" }); assert.equal(head.response.status, 200); assert.equal(head.bytes.length, 0);
    }
    for (const tag of ['"fixture"', 'W/"fixture"', '"other", W/"fixture"', '*']) {
      const conditional = await app.request(resource, { headers: { "If-None-Match": tag } });
      assert.equal(conditional.response.status, 304, tag); assert.equal(conditional.bytes.length, 0);
    }
    assert.equal((await app.request(resource)).response.status, 200);
    assert.equal((await app.request(resource, { headers: { "If-None-Match": '"fixture"' } })).response.status, 304);
    const limitedHead = await app.request(resource, { method: "HEAD" });
    assert.equal(limitedHead.response.status, 429); assert.equal(limitedHead.bytes.length, 0);
    const next = await app.request(resource);
    assert.equal(next.response.status, 429); assert.equal(next.body?.code, "FITTING_MODEL_RATE_LIMIT");
  } finally { await app.close(); }
});

test("rate tracking caps unique users and expires entries without trusting query owner IDs", async () => {
  let clock = 0;
  const app = await fixture({ adapters: { now: () => clock, limits: tinyLimits({ users: 2, requests: 2 }) } });
  try {
    assert.equal((await app.request(resource)).response.status, 200);
    assert.equal((await app.request(resource)).response.status, 200);
    assert.equal((await app.request(resource)).body?.code, "FITTING_MODEL_RATE_LIMIT");
    assert.equal((await app.request(resource, { headers: { "x-qa-user": "2" } })).response.status, 200);
    assert.equal((await app.request(resource, { headers: { "x-qa-user": "3" } })).response.status, 429);
    clock = 60_000;
    assert.equal((await app.request(resource, { headers: { "x-qa-user": "3" } })).response.status, 200);
  } finally { await app.close(); }
});

test("queue exhaustion, source outages and integrity failures are typed and never expose upstream content", async () => {
  for (const [status, code] of [[503, "FITTING_MODEL_BUSY"], [503, "FITTING_MODEL_UPSTREAM_UNAVAILABLE"], [409, "FITTING_MODEL_BUILD_CHANGED"], [502, "FITTING_MODEL_RESOURCE_INVALID"], [413, "FITTING_MODEL_RESOURCE_TOO_LARGE"]] as const) {
    const app = await fixture({ adapters: { getResource: async () => { throw new FittingModelError(status, code, "资源暂不可用，请稍后重试。"); } } });
    try { const result = await app.request(resource); assert.equal(result.response.status, status); assert.equal(result.body?.code, code); } finally { await app.close(); }
  }
  const app = await fixture({ adapters: { getSource: async () => { throw new Error("SECRET upstream HTML <body>fixture-token</body>"); } } });
  try {
    const result = await app.request(metadata);
    assert.equal(result.response.status, 500); assert.equal(result.body?.code, "FITTING_UNAVAILABLE");
    assert.ok(!result.bytes.toString("utf8").includes("fixture-token"));
  } finally { await app.close(); }
});

test("invalid upstream model build never creates malformed resource URLs or drifts from the integer contract", async () => {
  for (const build of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 2147483648, 1.5]) {
    const app = await fixture({ adapters: { getSource: async () => ({ clientBuild: build }) } });
    try { const result = await app.request(metadata); assert.equal(result.response.status, 502); assert.equal(result.body?.code, "FITTING_MODEL_BUILD_INVALID"); } finally { await app.close(); }
  }
});
