import assert from "node:assert/strict";
import test from "node:test";
import { fetchFittingSkills } from "./fitting-workbench-skills";
import { FittingWorkbenchError } from "./fitting-workbench-errors";

const response = (body: unknown, status = 200) => (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
const fail = (code: string) => (error: unknown) => error instanceof FittingWorkbenchError && error.code === code && !error.message.includes("token");

test("active skill reader preserves Alpha and expert-system differences", async () => {
  const skills = await fetchFittingSkills(90000002, "access-never-exposed", response({ skills: [
    { skill_id: 3426, active_skill_level: 2, trained_skill_level: 5 },
    { skill_id: 3413, active_skill_level: 5, trained_skill_level: 1 },
  ] }));
  assert.deepEqual(skills, [{ skillId: 3413, activeLevel: 5, trainedLevel: 1 }, { skillId: 3426, activeLevel: 2, trainedLevel: 5 }]);
});

test("new read-only ESI route pins compatibility and tokens stay in the Authorization header", async () => {
  const request = (async (url, init) => {
    assert.equal(String(url), "https://esi.evetech.net/characters/90000002/skills");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("X-Compatibility-Date"), "2020-01-01");
    assert.equal(headers.get("Authorization"), "Bearer private-access");
    return new Response(JSON.stringify({ skills: [] }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await fetchFittingSkills(90000002, "private-access", request), []);
});

test("401 and 403 require reauthorization; rate limits, outages, network and HTML are retryable", async () => {
  for (const status of [401, 403]) await assert.rejects(fetchFittingSkills(90000002, "secret", response("<html>private provider response</html>", status)), fail("SKILL_AUTHORIZATION_REQUIRED"));
  for (const status of [400, 429, 500, 503]) await assert.rejects(fetchFittingSkills(90000002, "secret", response("private token body", status)), fail("ESI_SKILLS_UNAVAILABLE"));
  await assert.rejects(fetchFittingSkills(90000002, "secret", response("<html>upstream error</html>")), fail("ESI_SKILLS_UNAVAILABLE"));
  await assert.rejects(fetchFittingSkills(90000002, "secret", (async () => { throw new Error("request contains private token"); }) as typeof fetch), fail("ESI_SKILLS_UNAVAILABLE"));
});

test("malformed, missing-active, duplicated and excessive skill payloads cannot become simulated skills", async () => {
  for (const skills of [
    [{ skill_id: 3426, trained_skill_level: 5 }],
    [{ skill_id: 3426, active_skill_level: 6, trained_skill_level: 5 }],
    [{ skill_id: 3426, active_skill_level: 2.5, trained_skill_level: 5 }],
    [{ skill_id: 3426, active_skill_level: 3, trained_skill_level: -1 }],
    [{ skill_id: 0, active_skill_level: 3, trained_skill_level: 5 }],
    Array(2).fill({ skill_id: 3426, active_skill_level: 3, trained_skill_level: 5 }),
    Array(2001).fill({ skill_id: 3426, active_skill_level: 3, trained_skill_level: 5 }),
  ]) await assert.rejects(fetchFittingSkills(90000002, "secret", response({ skills })), fail("ESI_SKILLS_UNAVAILABLE"));
  await assert.rejects(fetchFittingSkills(90000002, "secret", response({ error: "private token" })), fail("ESI_SKILLS_UNAVAILABLE"));
});
