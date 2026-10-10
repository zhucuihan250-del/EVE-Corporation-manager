import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import express, { type Request, type ErrorRequestHandler } from "express";
import type { Server } from "node:http";
import activityRouter from "../routes/activity";
import { settleDueActivityMonths } from "./activity-monthly-settlement";
import { db, pg, initializeActivityFixture, resetActivityFixture } from "./activity-test-fixture";
import { corporationRosterConnectionsTable } from "@workspace/db";
import type { buildActivityReport } from "./activity-report";
import type { getRecentUnboundMemberAudit } from "./corporation-roster";

// Bundle @workspace/db to ./src/lib/activity-test-fixture.ts. No live database or EVE calls.
type Report = ReturnType<typeof buildActivityReport>;
type Audit = Awaited<ReturnType<typeof getRecentUnboundMemberAudit>>;
const realFetch = globalThis.fetch;
const originalPrimaryCorporation = process.env.PRIMARY_CORPORATION_ID;
const now = new Date();
const monthAt = (offset: number) => {
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2,"0")}`;
};
const startedAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 3, 1));
let server: Server;
let origin = "";
let rosterFails = false;
let requestFailure: unknown;

before(async () => {
  process.env.PRIMARY_CORPORATION_ID = "1001";
  await initializeActivityFixture();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = Number(req.headers["x-test-user"] ?? 0);
    req.session = { userId, corporationId: userId === 7 ? 2002 : 1001, eveCharacterId: userId * 100 + 1,
      save: (done?: (error?: Error) => void) => done?.() } as unknown as Request["session"];
    next();
  });
  app.use("/api", activityRouter);
  app.use(((error, _req, res, _next) => { requestFailure = error; res.status(500).json({ error: "Fixture failure" }); }) as ErrorRequestHandler);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  origin = `http://127.0.0.1:${address.port}`;
  globalThis.fetch = (async (input: string | URL | globalThis.Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(`${origin}/`)) return realFetch(input, init);
    if (url === "https://esi.evetech.net/latest/corporations/1001/membertracking/?datasource=tranquility") {
      if (rosterFails) return Response.json({ error: "fixture denied" }, { status: 403 });
      return Response.json([
        { character_id: 201, start_date: "2020-01-01T00:00:00Z" },
        { character_id: 401, start_date: "2020-01-01T00:00:00Z" },
        { character_id: 301, start_date: "2020-01-01T00:00:00Z" },
        { character_id: 1001, start_date: "2020-01-01T00:00:00Z" },
        { character_id: 60001, start_date: "2020-01-01T00:00:00Z" },
        { character_id: 60002 },
        { character_id: 60003, start_date: now.toISOString() },
      ]);
    }
    if (url === "https://esi.evetech.net/latest/universe/names/?datasource=tranquility") {
      return Response.json((JSON.parse(String(init?.body)) as number[]).map((id) => ({ id, name: `Fixture ${id}`, category: "character" })));
    }
    throw new Error(`Unexpected remote request in activity test: ${url}`);
  }) as typeof fetch;
});

beforeEach(async () => {
  rosterFails = false;
  requestFailure = undefined;
  await resetActivityFixture(now, startedAt);
});
after(async () => {
  globalThis.fetch = realFetch;
  if (originalPrimaryCorporation === undefined) delete process.env.PRIMARY_CORPORATION_ID;
  else process.env.PRIMARY_CORPORATION_ID = originalPrimaryCorporation;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pg.close();
});
function request(path = "", userId = 1, method = "GET", body?: unknown) {
  return fetch(`${origin}/api/activity${path}`, { method, headers: { "x-test-user": String(userId), "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
async function connectRoster() {
  await db.insert(corporationRosterConnectionsTable).values({ corporationId: 1001, characterId: 101, connectedBy: 1,
    accessToken: "not-real-roster-access", refreshToken: "not-real-roster-refresh", tokenExpiry: new Date(Date.now() + 86400000) });
}

test("actual activity routes enforce authentication, current member identity and management permission", async () => {
  for (const path of ["", "/new-members"]) {
    assert.equal((await request(path, 0)).status, 401);
    for (const id of [2, 3, 7, 10]) assert.equal((await request(path, id)).status, 403);
    assert.equal((await request(path, 1)).status, 200, String(requestFailure));
    assert.equal((await request(path, 9)).status, 200, String(requestFailure));
  }
  await pg.exec("UPDATE identity_groups SET is_active=false");
  assert.equal((await request("",9)).status,403);
  await pg.exec("UPDATE corporations SET pap_enabled=false WHERE id=1001");
  assert.equal((await request("",1)).status,404);
});

test("month validation and fixed monthly settings remain backward compatible with backend permission checks", async () => {
  assert.equal((await request("?month=not-a-month")).status,400);
  assert.equal((await request(`?month=${monthAt(1)}`)).status,400);
  assert.equal((await request("/settings",2,"PATCH",{minimumPap:2})).status,403);
  assert.equal((await request("/settings",1,"PATCH",{minimumPap:3})).status,400);
  assert.equal((await request("/settings",1,"PATCH",{minimumPap:2})).status,200);
});

test("real monthly settlement deducts only authorized eligible current members and is idempotent", async () => {
  const first = await settleDueActivityMonths(now);
  assert.deepEqual(first,{settlementsCreated:3,membersSettled:15,totalPapDeducted:7.25});
  assert.deepEqual(await settleDueActivityMonths(now),{settlementsCreated:0,membersSettled:0,totalPapDeducted:0});
  const deductionUsers = await pg.query<{user_id:number}>("SELECT DISTINCT user_id FROM activity_monthly_deductions ORDER BY user_id");
  assert.deepEqual(deductionUsers.rows.map((row)=>row.user_id),[1,2,5,8,9]);
  const retained = await pg.query<{id:number;redeemable_pap:number}>("SELECT id,redeemable_pap FROM users WHERE id IN (3,4,7,10) ORDER BY id");
  assert.ok(retained.rows.every((row)=>row.redeemable_pap===42));
  const rows = await pg.query<{count:number}>("SELECT COUNT(*)::integer AS count FROM pap_ledger WHERE type='activity_deduction'");
  assert.equal(rows.rows[0]!.count,4);
});

test("actual report reads real settlement rows and alerts at three completed months only", async () => {
  await settleDueActivityMonths(now);
  const response = await request();
  assert.equal(response.status,200,String(requestFailure));
  const report = await response.json() as Report;
  assert.equal(report.alertThresholdMonths,3);
  assert.equal(report.totalEligible,5);
  assert.equal(report.belowRequirement,4);
  const member = report.members.find((row)=>row.userId===2)!;
  assert.equal(member.consecutiveInsufficientMonths,3);
  assert.equal(member.hasInsufficientPapAlert,true);
  assert.equal(member.currentMonthHasShortfall,true);
  assert.equal(member.deductionStatus,"scheduled");
  assert.equal(member.alertAnchorMonth,monthAt(-1));
  assert.ok(!report.members.some((row)=>[3,4,6,7,10].includes(row.userId)));
});

test("actual report shows one/two settled shortages as observation and a missing deduction as unknown", async () => {
  await settleDueActivityMonths(now);
  await pg.query("DELETE FROM activity_monthly_settlements WHERE month=$1",[monthAt(-3)]);
  const observation = await (await request(`?month=${monthAt(-1)}`)).json() as Report;
  const observed = observation.members.find((row)=>row.userId===2)!;
  assert.equal(observed.consecutiveInsufficientMonths,2);
  assert.equal(observed.hasInsufficientPapAlert,false);
  assert.equal(observed.deductionStatus,"insufficient");
  await pg.query("DELETE FROM activity_monthly_deductions WHERE user_id=2 AND settlement_id=(SELECT id FROM activity_monthly_settlements WHERE month=$1)",[monthAt(-1)]);
  const missing = await (await request(`?month=${monthAt(-1)}`)).json() as Report;
  const unknown = missing.members.find((row)=>row.userId===2)!;
  assert.equal(unknown.settledDeductionPap,null);
  assert.equal(unknown.deductionStatus,"pending");
  assert.equal(unknown.consecutiveInsufficientMonths,0);
  assert.equal(unknown.hasInsufficientPapAlert,false);
});

test("all-member roster route includes old and unknown-date unbound members but not authorized characters", async () => {
  await connectRoster();
  const response = await request("/new-members");
  assert.equal(response.status,200,String(requestFailure));
  const audit = await response.json() as Audit;
  assert.equal(audit.auditScope,"all");
  assert.equal(audit.reviewedMemberCount,7);
  assert.equal(audit.unknownJoinDateCount,1);
  assert.equal(audit.unboundMemberCount,6);
  assert.ok(!audit.members.some((member)=>member.characterId===201));
  assert.ok(audit.members.some((member)=>member.characterId===401));
  assert.ok(audit.members.some((member)=>member.characterId===60001));
  const unknown = audit.members.find((member)=>member.characterId===60002)!;
  assert.equal(unknown.corporationJoinedAt,null);
  assert.equal(unknown.daysInCorporation,null);
  assert.equal(unknown.joinDateKnown,false);
});

test("roster errors remain errors rather than an all-bound claim", async () => {
  const unconnected = await (await request("/new-members")).json() as Audit;
  assert.equal(unconnected.connection,null);
  assert.equal(unconnected.reviewedAt,null);
  await connectRoster();
  rosterFails = true;
  const response = await request("/new-members");
  assert.equal(response.status,502);
  const failure = await response.json() as {error:string;connection:{status:string;lastError:string}};
  assert.equal(failure.connection.status,"error");
  assert.match(failure.error,/Director/);
  assert.ok(!("members" in failure));
});
