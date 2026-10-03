import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeFittingEngine } from "./fitting-engine";
import { createFittingWorkbenchFixture, fittingFixtureInput, FITTING_FIXTURE_ACTORS as actors } from "./fitting-workbench-test-fixture";
import { FittingWorkbenchError } from "./fitting-workbench-errors";
import { SkillAuditError } from "./identity-skills-client";
import type { CanonicalFit, WorkbenchSimulation } from "./fitting-engine-types";

after(closeFittingEngine);
const requestBody = (visibility = "personal", fit = fittingFixtureInput()) => ({ name: fit.name, description: "测试保存", visibility, fit });
const fail = (code: string) => (error: unknown) => error instanceof FittingWorkbenchError && error.code === code;
type Fixture = Awaited<ReturnType<typeof createFittingWorkbenchFixture>>;
async function withHttp(fixture: Fixture, handler: (request: (path: string, user?: number, method?: string, body?: unknown) => Promise<Response>) => Promise<void>) {
  const { url, server } = await fixture.listen();
  const request = (path: string, user = 2, method = "GET", body?: unknown) => fetch(`${url}/api${path}`, { method, headers: { "x-test-user": String(user), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  try { await handler(request); }
  finally { await new Promise<void>(resolve => server.close(() => resolve())); }
}

test("0032 migration is additive, repeatable, and creates no seeded fittings", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    await fixture.runMigration();
    assert.deepEqual((await fixture.service.listSaved(actors[2]!)).fittings, []);
    assert.deepEqual((await fixture.pg.query("SELECT total_pap,redeemable_pap FROM users WHERE id=2")).rows, [{ total_pap: 12, redeemable_pap: 12 }]);
    const { fitting } = await fixture.service.createSaved(actors[2]!, requestBody());
    await fixture.runMigration();
    assert.equal((await fixture.service.getSaved(actors[2]!, fitting.id)).fitting.name, "Tristan Test");
    await assert.rejects(fixture.pg.query("UPDATE fittings SET visibility='corporation' WHERE id=$1", [fitting.id]));
    await assert.rejects(fixture.pg.query("UPDATE fittings SET fit='{}'::jsonb WHERE id=$1", [fitting.id]));
    await assert.rejects(fixture.pg.query("UPDATE fittings SET version=0 WHERE id=$1", [fitting.id]));
  } finally { await fixture.close(); }
});

test("personal fittings remain private even to administrators and foreign corporations", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    const { fitting } = await fixture.service.createSaved(actors[2]!, { ...requestBody(), ownerUserId: 3, corporationId: 2002 });
    assert.equal(fitting.ownerUserId, 2);
    for (const id of [1, 3, 4]) {
      assert.deepEqual((await fixture.service.listSaved(actors[id]!)).fittings, []);
      await assert.rejects(fixture.service.getSaved(actors[id]!, fitting.id), fail("FITTING_NOT_FOUND"));
      await assert.rejects(fixture.service.updateSaved(actors[id]!, fitting.id, { ...requestBody(), version: 1 }), fail("FITTING_NOT_FOUND"));
      await assert.rejects(fixture.service.deleteSaved(actors[id]!, fitting.id, { version: 1 }), fail("FITTING_NOT_FOUND"));
    }
    assert.equal((await fixture.service.getSaved(actors[2]!, fitting.id)).fitting.canEdit, true);
  } finally { await fixture.close(); }
});

test("corporation reads are scoped and writes use FC or existing fleet.manage permission", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    await assert.rejects(fixture.service.createSaved(actors[2]!, requestBody("corporation")), fail("FITTING_MANAGER_REQUIRED"));
    const { fitting } = await fixture.service.createSaved(actors[5]!, requestBody("corporation"));
    assert.equal(fitting.ownerUserId, null);
    assert.equal((await fixture.service.getSaved(actors[2]!, fitting.id)).fitting.canEdit, false);
    assert.equal((await fixture.service.getSaved(actors[6]!, fitting.id)).fitting.canEdit, true);
    await assert.rejects(fixture.service.updateSaved(actors[2]!, fitting.id, { ...requestBody("corporation"), version: 1 }), fail("FITTING_MANAGER_REQUIRED"));
    await assert.rejects(fixture.service.getSaved(actors[4]!, fitting.id), fail("FITTING_NOT_FOUND"));
    assert.deepEqual((await fixture.service.listSaved(actors[4]!)).fittings, []);
    const updated = await fixture.service.updateSaved(actors[6]!, fitting.id, { ...requestBody("corporation"), name: "管理组修改", version: 1 });
    assert.equal(updated.fitting.version, 2);
    assert.equal(updated.fitting.name, "管理组修改");
    assert.equal(updated.fitting.authorName, "测试 FC");
    await fixture.pg.query("DELETE FROM users WHERE id=5");
    assert.equal((await fixture.service.getSaved(actors[2]!, fitting.id)).fitting.authorName, "测试 FC");
  } finally { await fixture.close(); }
});

test("creation quotas use FK-compatible exclusive locks and still enforce personal and corporation limits", async () => {
  const lockQueries: string[] = [];
  const fixture = await createFittingWorkbenchFixture({ logQuery: query => { if (/\bfor\s+(?:no\s+key\s+)?update\b/i.test(query)) lockQueries.push(query); } });
  try {
    // PGlite validates SQL and quota behavior, not multi-session lock contention.
    // Inspect the real service statements so accidental FOR UPDATE regression
    // cannot reintroduce the PostgreSQL cross-parent FK lock cycle.
    const personal = (await fixture.service.createSaved(actors[5]!, requestBody())).fitting;
    const corporation = (await fixture.service.createSaved(actors[5]!, requestBody("corporation"))).fitting;
    assert.equal(lockQueries.length, 2);
    assert.ok(lockQueries.every(query => /\bfor no key update\b/i.test(query)));
    assert.ok(lockQueries.some(query => query.includes('from "users"')));
    assert.ok(lockQueries.some(query => query.includes('from "corporations"')));
    const copy = "INSERT INTO fittings(corporation_id,visibility,owner_user_id,created_by,updated_by,author_name,name,description,fit,simulation,version) SELECT corporation_id,visibility,owner_user_id,created_by,updated_by,author_name,name,description,fit,simulation,version FROM fittings CROSS JOIN generate_series(1,$2::integer) WHERE id=$1";
    await fixture.pg.query(copy, [personal.id, 249]);
    await fixture.pg.query(copy, [corporation.id, 499]);
    for (const visibility of ["personal", "corporation"]) await assert.rejects(fixture.service.createSaved(actors[5]!, requestBody(visibility)), fail("FITTING_STORAGE_LIMIT"));
    const counts = await fixture.pg.query<{ visibility: string; count: number }>("SELECT visibility,count(*)::integer AS count FROM fittings GROUP BY visibility ORDER BY visibility");
    assert.deepEqual(counts.rows, [{ visibility: "corporation", count: 500 }, { visibility: "personal", count: 250 }]);
    await fixture.service.deleteSaved(actors[5]!, personal.id, { version: 1 });
    await fixture.service.deleteSaved(actors[5]!, corporation.id, { version: 1 });
    assert.equal((await fixture.service.createSaved(actors[5]!, requestBody())).fitting.visibility, "personal");
    assert.equal((await fixture.service.createSaved(actors[5]!, requestBody("corporation"))).fitting.visibility, "corporation");
    assert.ok(lockQueries.every(query => /\bfor no key update\b/i.test(query)));
  } finally { await fixture.close(); }
});

test("versions prevent overwrite, stale deletion and changing a personal fitting into corporation scope", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    const { fitting } = await fixture.service.createSaved(actors[2]!, requestBody());
    await assert.rejects(fixture.service.updateSaved(actors[2]!, fitting.id, { ...requestBody("corporation"), version: 1 }), fail("FITTING_VISIBILITY_IMMUTABLE"));
    const attempts = await Promise.allSettled(["第一编辑", "第二编辑"].map(name => fixture.service.updateSaved(actors[2]!, fitting.id, { ...requestBody(), name, version: 1 })));
    assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
    const rejected = attempts.find(result => result.status === "rejected") as PromiseRejectedResult;
    assert.equal(rejected.reason.code, "FITTING_VERSION_CONFLICT");
    await assert.rejects(fixture.service.deleteSaved(actors[2]!, fitting.id, { version: 1 }), fail("FITTING_VERSION_CONFLICT"));
    await assert.rejects(fixture.service.deleteSaved(actors[2]!, fitting.id, {}), fail("FITTING_INVALID_VERSION"));
    assert.deepEqual(await fixture.service.deleteSaved(actors[2]!, fitting.id, { version: 2 }), { deleted: true });
    await assert.rejects(fixture.service.getSaved(actors[2]!, fitting.id), fail("FITTING_NOT_FOUND"));
  } finally { await fixture.close(); }
});

test("structurally valid overfitted simulations can be saved with violations instead of being rejected", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    const fit = fittingFixtureInput({ slots: Array.from({ length: 12 }, (_, index) => ({ rack: "high" as const, index, typeId: 10678, state: "active" as const, chargeTypeId: 222 })) });
    const { fitting } = await fixture.service.createSaved(actors[2]!, requestBody("personal", fit));
    const simulation = fitting.simulation as unknown as WorkbenchSimulation;
    assert.equal(simulation.valid, false);
    assert.ok(simulation.violations.length > 0);
    assert.equal((fitting.fit as unknown as CanonicalFit).slots.length, 12);
    assert.ok(Number.isFinite(simulation.resources.cpu.used));
    await assert.rejects(fixture.service.createSaved(actors[2]!, requestBody("personal", fittingFixtureInput({ shipTypeId: 34 }))));
  } finally { await fixture.close(); }
});

test("bounded keyset pagination exposes every eligible fitting once and validates request values", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    const ids: number[] = [];
    for (const name of ["one", "two", "three"]) ids.push((await fixture.service.createSaved(actors[2]!, { ...requestBody(), name })).fitting.id);
    const page1 = await fixture.service.listSaved(actors[2]!, { limit: 2 });
    const page2 = await fixture.service.listSaved(actors[2]!, { limit: 2, cursor: page1.nextCursor });
    assert.deepEqual([...page1.fittings, ...page2.fittings].map(row => row.id), ids.reverse());
    assert.equal(page2.nextCursor, null);
    await assert.rejects(fixture.service.listSaved(actors[2]!, { limit: 201 }), fail("FITTING_INVALID_LIMIT"));
    await assert.rejects(fixture.service.listSaved(actors[2]!, { cursor: "1e3" }), fail("FITTING_INVALID_ID"));
    await assert.rejects(fixture.service.createSaved(actors[2]!, { ...requestBody(), name: "x\n".repeat(3) }), fail("FITTING_INVALID_NAME"));
    await assert.rejects(fixture.service.createSaved(actors[2]!, { ...requestBody(), description: "x".repeat(2001) }), fail("FITTING_INVALID_DESCRIPTION"));
  } finally { await fixture.close(); }
});

test("skills endpoints expose only the current user's active same-corporation bindings without tokens", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    assert.deepEqual((await fixture.skills.listCharacters(actors[2]!)).characters.map(row => row.id), [20, 21]);
    const snapshot = await fixture.skills.getSkills(actors[2]!, 20);
    assert.deepEqual(snapshot.skills[0], { skillId: 3426, activeLevel: 3, trainedLevel: 5 });
    assert.equal(JSON.stringify(snapshot).includes("fixture-access"), false);
    for (const id of [22, 23, 30, 40]) await assert.rejects(fixture.skills.getSkills(actors[2]!, id), fail("FITTING_CHARACTER_NOT_FOUND"));
    await assert.rejects(fixture.skills.getSkills(actors[1]!, 20), fail("FITTING_CHARACTER_NOT_FOUND"));
    await fixture.pg.query("UPDATE characters SET deleted_at=now() WHERE id=20");
    await assert.rejects(fixture.skills.getSkills(actors[2]!, 20), fail("FITTING_CHARACTER_NOT_FOUND"));
  } finally { await fixture.close(); }
});

test("character simulation uses active levels rather than trained levels or client-supplied skill maps", async () => {
  let calls = 0;
  const fixture = await createFittingWorkbenchFixture({ fetchSkills: async () => { calls++; return [{ skillId: 3426, activeLevel: 3, trainedLevel: 5 }]; } });
  try {
    const none = await fixture.service.simulate(actors[2]!, { fit: fittingFixtureInput({ skillProfile: { mode: "none" } }) });
    const all = await fixture.service.simulate(actors[2]!, { fit: fittingFixtureInput() });
    const real = await fixture.service.simulate(actors[2]!, { fit: fittingFixtureInput({ skillProfile: { mode: "character", characterId: 20 } }) });
    assert.ok(none.resources.cpu.limit < real.resources.cpu.limit);
    assert.ok(real.resources.cpu.limit < all.resources.cpu.limit);
    assert.equal(real.skillSource.characterId, 20);
    assert.equal(real.skillSource.characterName, "测试成员");
    assert.equal(calls, 1);
    await assert.rejects(fixture.service.simulate(actors[2]!, { fit: fittingFixtureInput({ skillProfile: { mode: "character", characterId: 30 } }) }), fail("FITTING_CHARACTER_NOT_FOUND"));
    await assert.rejects(fixture.service.simulate(actors[2]!, { fit: fittingFixtureInput(), skills: { 3426: 5 } }), fail("FITTING_SERVER_SKILLS_REQUIRED"));
  } finally { await fixture.close(); }
});

test("skill refresh rotates tokens once for concurrent requests and preserves trained audit semantics", async () => {
  let refreshes = 0, reads = 0;
  const fixture = await createFittingWorkbenchFixture({ refreshTokens: async () => { refreshes++; return { accessToken: "rotated-access", refreshToken: "rotated-refresh", expiresIn: 3600 }; }, fetchSkills: async (_id, token) => { reads++; assert.equal(token, "rotated-access"); return [{ skillId: 3426, activeLevel: 1, trainedLevel: 5 }]; } });
  try {
    await fixture.pg.query("UPDATE characters SET token_expiry=now()-interval '1 hour' WHERE id=20");
    await fixture.pg.query("UPDATE users SET access_token='fixture-access',refresh_token='fixture-refresh',token_expiry=now()-interval '1 hour' WHERE id=2");
    const [first, second] = await Promise.all([fixture.skills.getSkills(actors[2]!, 20), fixture.skills.getSkills(actors[2]!, 20)]);
    assert.deepEqual(first, second); assert.equal(refreshes, 1); assert.equal(reads, 1);
    assert.deepEqual((await fixture.pg.query("SELECT access_token,refresh_token FROM users WHERE id=2")).rows[0], { access_token: "rotated-access", refresh_token: "rotated-refresh" });
    assert.equal(first.skills[0]!.trainedLevel, 5);
  } finally { await fixture.close(); }
});

test("authorization loss and provider outages return distinct safe typed errors", async () => {
  for (const code of ["SKILL_AUTHORIZATION_REQUIRED", "ESI_SKILLS_UNAVAILABLE"] as const) {
    const fixture = await createFittingWorkbenchFixture({ refreshTokens: async () => { throw new SkillAuditError("secret-provider-token-body", code); } });
    try {
      await fixture.pg.query("UPDATE characters SET token_expiry=now()-interval '1 hour' WHERE id=20");
      await withHttp(fixture, async request => {
        const response = await request("/fitting/characters/20/skills");
        assert.equal(response.status, code === "SKILL_AUTHORIZATION_REQUIRED" ? 409 : 503);
        const text = await response.text(); assert.ok(text.includes(code)); assert.equal(text.includes("secret-provider-token-body"), false);
      });
    } finally { await fixture.close(); }
  }
});

test("real router maintains legacy fields and all new paths require authentication and fleet availability", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    await withHttp(fixture, async request => {
      for (const path of ["/fitting/catalog", "/fitting/saved", "/fitting/characters", "/fitting/characters/20/skills"]) assert.equal((await request(path, 0)).status, 401);
      assert.equal((await request("/fitting/workbench", 0, "POST", { fit: fittingFixtureInput() })).status, 401);
      const old = await request("/fitting/simulate", 2, "POST", { shipId: 593, modules: [{ typeId: 439, quantity: 1 }], mode: "pvp", language: "zh" });
      assert.equal(old.status, 200);
      const result = await old.json() as WorkbenchSimulation & { calculationPrecision: string };
      assert.equal(result.precision, "approximate"); assert.equal(result.calculationPrecision, "dogma");
      for (const field of ["sdeBuildNumber", "ship", "modules", "slots", "resources", "hardpoints", "defense", "mobility", "capacitor", "offense", "recommendations", "limitations"]) assert.ok(Object.hasOwn(result, field));
      assert.equal((await request("/fitting/workbench", 2, "POST", { fit: fittingFixtureInput() })).status, 200);
      assert.equal((await request("/fitting/saved", 2, "POST", requestBody("corporation"))).status, 403);
      assert.equal((await request("/fitting/saved", 5, "POST", requestBody("corporation"))).status, 201);
    });
  } finally { await fixture.close(); }
  const disabled = await createFittingWorkbenchFixture({ fleetEnabled: false });
  try { await withHttp(disabled, async request => {
    for (const path of ["/fitting/catalog", "/fitting/saved", "/fitting/characters"]) assert.equal((await request(path, 1)).status, 404);
    for (const path of ["/fitting/workbench", "/fitting/import", "/fitting/export", "/fitting/saved"]) assert.equal((await request(path, 1, "POST", requestBody())).status, 404);
  }); } finally { await disabled.close(); }
});

test("HTTP EFT import/export accepts game text without trailing newline and preserves items and ammunition", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try { await withHttp(fixture, async request => {
    const text = "[Tristan, EOF Test]\nDamage Control II\n\n1MN Afterburner I\n\n125mm Railgun I, Antimatter Charge S\n\n\nWarrior II x5";
    const response = await request("/fitting/import", 2, "POST", { text, language: "zh" });
    assert.equal(response.status, 200);
    const first = await response.json() as { fit: CanonicalFit; warnings: string[] };
    assert.equal(first.fit.shipTypeId, 593); assert.equal(first.fit.slots.length, 3);
    assert.equal(first.fit.slots.find(slot => slot.typeId === 10678)?.chargeTypeId, 222);
    assert.equal(first.fit.drones[0]?.quantity, 5);
    const exported = await request("/fitting/export", 2, "POST", { fit: first.fit, language: "en" });
    assert.equal(exported.status, 200);
    const copied = await exported.json() as { text: string; warnings: string[] };
    const second = await request("/fitting/import", 2, "POST", { text: copied.text.trimEnd(), language: "en" });
    assert.equal(second.status, 200);
    const reimported = await second.json() as { fit: CanonicalFit };
    assert.deepEqual(reimported.fit.slots.map(slot => [slot.rack, slot.index, slot.typeId, slot.chargeTypeId]), first.fit.slots.map(slot => [slot.rack, slot.index, slot.typeId, slot.chargeTypeId]));
    assert.deepEqual(reimported.fit.drones, first.fit.drones);
    assert.ok(copied.warnings.length > 0);
    assert.equal((await request("/fitting/import", 2, "POST", { text: "[Tristan, Invalid]\nDefinitely not an EVE module" })).status, 422);
    assert.equal((await request("/fitting/import", 2, "POST", { text: "" })).status, 400);
  }); } finally { await fixture.close(); }
});

test("HTTP exact-ID catalog batches resolve imports, reject malformed IDs and return absent IDs explicitly", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try { await withHttp(fixture, async request => {
    const response = await request("/fitting/catalog?typeIds=593,222,2488,2147483647&language=zh");
    assert.equal(response.status, 200);
    const body = await response.json() as { items: { typeId: number }[]; missingTypeIds: number[] };
    assert.deepEqual(body.items.map(row => row.typeId), [593, 222, 2488]); assert.deepEqual(body.missingTypeIds, [2147483647]);
    assert.equal((await request("/fitting/catalog?typeIds=593,1e3")).status, 400);
    assert.equal((await request(`/fitting/catalog?typeIds=${Array(101).fill(593).join(",")}`)).status, 400);
    assert.equal((await request(`/fitting/catalog?q=${"x".repeat(101)}`)).status, 400);
    assert.equal((await request("/fitting/workbench", 2, "POST", null)).status, 400);
    assert.equal((await request("/fitting/saved/NaN", 2, "DELETE", { version: 1 })).status, 400);
    assert.equal((await request("/fitting/import", 2, "POST", { text: "x".repeat(70 * 1024) })).status, 400);
    const tooLarge = await request("/fitting/import", 2, "POST", { text: "private-payload".repeat(10000) });
    assert.equal(tooLarge.status, 413);
    const largeError = await tooLarge.text(); assert.ok(largeError.includes("FITTING_PAYLOAD_TOO_LARGE")); assert.equal(largeError.includes("private-payload"), false);
  }); } finally { await fixture.close(); }
});

test("unexpected database failures are safe JSON without SQL, private parameters or stack traces", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try {
    await fixture.pg.exec("DROP TABLE fittings");
    await withHttp(fixture, async request => {
      const response = await request("/fitting/saved"); assert.equal(response.status, 500);
      const body = await response.json() as { error: string; code: string };
      assert.equal(body.code, "FITTING_UNAVAILABLE"); assert.equal(JSON.stringify(body).includes("SELECT"), false); assert.equal(JSON.stringify(body).includes("fixture-access"), false);
    });
  } finally { await fixture.close(); }
});

test("authenticated request windows bound read traffic without changing stored fitting data", async () => {
  const fixture = await createFittingWorkbenchFixture();
  try { await withHttp(fixture, async request => {
    for (let index = 0; index < 180; index++) assert.equal((await request("/fitting/characters")).status, 200);
    const limited = await request("/fitting/characters");
    assert.equal(limited.status, 429); assert.equal(limited.headers.get("retry-after"), "60");
    assert.equal((await request("/fitting/characters", 3)).status, 200);
    assert.deepEqual((await fixture.service.listSaved(actors[2]!)).fittings, []);
  }); } finally { await fixture.close(); }
});
