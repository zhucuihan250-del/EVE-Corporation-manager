import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { fetchTrainedSkills, refreshSkillTokens, SkillAuditError } from "./identity-skills-client";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function configureSso(t: TestContext) {
  const clientId = process.env.EVE_CLIENT_ID;
  const clientSecret = process.env.EVE_CLIENT_SECRET;
  process.env.EVE_CLIENT_ID = "test-client";
  process.env.EVE_CLIENT_SECRET = "test-secret";
  t.after(() => {
    if (clientId === undefined) delete process.env.EVE_CLIENT_ID;
    else process.env.EVE_CLIENT_ID = clientId;
    if (clientSecret === undefined) delete process.env.EVE_CLIENT_SECRET;
    else process.env.EVE_CLIENT_SECRET = clientSecret;
  });
}

const hasCode = (code: SkillAuditError["code"]) => (error: unknown) => {
  assert.ok(error instanceof SkillAuditError);
  assert.equal(error.code, code);
  return true;
};

test("expired or missing EVE grant requires authorization instead of an unhandled 500", async (t) => {
  configureSso(t);
  t.mock.method(globalThis, "fetch", async () => jsonResponse({
    error: "invalid_grant", error_description: "Invalid refresh token. Character grant missing/expired.",
  }, 400));
  await assert.rejects(refreshSkillTokens("test-refresh"), hasCode("SKILL_AUTHORIZATION_REQUIRED"));
});

test("SSO configuration errors and outages do not blame the member's authorization", async (t) => {
  configureSso(t);
  for (const response of [
    jsonResponse({ error: "invalid_client" }, 400),
    jsonResponse({ error: "invalid_client" }, 401),
    jsonResponse({ error: "invalid_grant" }, 503),
    new Response("<html>Bad Gateway</html>", { status: 502 }),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => response);
    await assert.rejects(refreshSkillTokens("test-refresh"), hasCode("ESI_SKILLS_UNAVAILABLE"));
    mock.mock.restore();
  }
});

test("missing server credentials are unavailable data, not a revoked character grant", async (t) => {
  configureSso(t);
  delete process.env.EVE_CLIENT_SECRET;
  const request = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not fetch"); });
  await assert.rejects(refreshSkillTokens("test-refresh"), hasCode("ESI_SKILLS_UNAVAILABLE"));
  assert.equal(request.mock.callCount(), 0);
});

test("refresh network errors and malformed successful responses are handled safely", async (t) => {
  configureSso(t);
  const cases = [
    async () => { throw new TypeError("fetch failed"); },
    async () => { throw new DOMException("timed out", "TimeoutError"); },
    async () => new Response("not json"),
    async () => jsonResponse(null),
    async () => jsonResponse({}),
    async () => jsonResponse({ access_token: {}, refresh_token: "test", expires_in: 1200 }),
    async () => jsonResponse({ access_token: "test", refresh_token: "test", expires_in: -1 }),
  ];
  for (const request of cases) {
    const mock = t.mock.method(globalThis, "fetch", request);
    await assert.rejects(refreshSkillTokens("test-refresh"), hasCode("ESI_SKILLS_UNAVAILABLE"));
    mock.mock.restore();
  }
});

test("successful refresh returns rotated tokens and bounds the request duration", async (t) => {
  configureSso(t);
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "https://login.eveonline.com/v2/oauth/token");
    assert.equal(init.method, "POST");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(new URLSearchParams(String(init.body)).get("refresh_token"), "test-refresh");
    return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 1200 });
  });
  assert.deepEqual(await refreshSkillTokens("test-refresh"), {
    accessToken: "new-access", refreshToken: "new-refresh", expiresIn: 1200,
  });
});

test("ESI 401 and 403 request authorization, while service failures remain retryable", async (t) => {
  for (const status of [401, 403, 429, 500, 503]) {
    const mock = t.mock.method(globalThis, "fetch", async () => new Response("unavailable", { status }));
    await assert.rejects(fetchTrainedSkills(123, "test-access"), hasCode(
      status === 401 || status === 403 ? "SKILL_AUTHORIZATION_REQUIRED" : "ESI_SKILLS_UNAVAILABLE",
    ));
    mock.mock.restore();
  }
});

test("invalid ESI payloads never become an empty or failed skill audit", async (t) => {
  for (const payload of [null, {}, { skills: null }, { skills: [null] },
    { skills: [{ skill_id: "3300", trained_skill_level: 5 }] },
    { skills: [{ skill_id: 3300, trained_skill_level: 6 }] },
    { skills: [{ skill_id: 3300, trained_skill_level: -1 }] },
  ]) {
    const mock = t.mock.method(globalThis, "fetch", async () => jsonResponse(payload));
    await assert.rejects(fetchTrainedSkills(123, "test-access"), hasCode("ESI_SKILLS_UNAVAILABLE"));
    mock.mock.restore();
  }
});

test("ESI network failures, timeouts and invalid JSON produce unavailable data", async (t) => {
  for (const request of [
    async () => { throw new TypeError("fetch failed"); },
    async () => { throw new DOMException("timed out", "TimeoutError"); },
    async () => new Response("<html>Error</html>"),
  ]) {
    const mock = t.mock.method(globalThis, "fetch", request);
    await assert.rejects(fetchTrainedSkills(123, "test-access"), hasCode("ESI_SKILLS_UNAVAILABLE"));
    mock.mock.restore();
  }
});

test("valid skills preserve trained levels and use a bounded authenticated request", async (t) => {
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.match(url, /\/characters\/123\/skills\//);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer test-access");
    assert.ok(init.signal instanceof AbortSignal);
    return jsonResponse({ skills: [
      { skill_id: 3300, trained_skill_level: 5 },
      { skill_id: 3301, trained_skill_level: 0 },
    ] });
  });
  assert.deepEqual(await fetchTrainedSkills(123, "test-access"), new Map([[3300, 5], [3301, 0]]));
});

test("an explicitly empty ESI skills list is valid data", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ skills: [] }));
  assert.deepEqual(await fetchTrainedSkills(123, "test-access"), new Map());
});
