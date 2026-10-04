import assert from "node:assert/strict";
import test, { after } from "node:test";
import { closeFittingEngine, exportEft, simulateWorkbench, validateCanonicalFit } from "./fitting-engine";
import { getFittingData } from "./fitting-data";
import { createFittingAdviceService, buildFittingAdviceCandidates, fittingAdviceChanges } from "./fitting-advice-service";
import { adviceError, createOpenAiFittingAdviceProvider, fittingAdviceOutputSchema, type FittingAdviceProvider, type FittingAdviceProviderInput } from "./fitting-advice-provider";
import { FittingWorkbenchError, type FittingActor } from "./fitting-workbench-errors";
import type { CanonicalFit } from "./fitting-engine-types";
import type { FittingSkillContext, FittingWorkbenchEngine } from "./fitting-workbench-service";
import type { FittingAdvicePrice, FittingAdviceResponse } from "./fitting-advice-types";
import { createFittingWorkbenchFixture } from "./fitting-workbench-test-fixture";

after(closeFittingEngine);
const typeId = (name: string) => { const type = getFittingData().types.find(type => type.name.en === name); assert.ok(type, name); return type.id; };
const actor: FittingActor = { corporationId: 1001, userId: 2, userName: "Private name not sent to model", role: "member", permissions: [] };
const base = (extra: Partial<CanonicalFit> = {}): CanonicalFit => ({ schemaVersion: 2, shipTypeId: typeId("Rifter"), name: "Personal private fit name", slots: [{ rack: "high", index: 0, typeId: typeId("200mm AutoCannon II"), state: "online", chargeTypeId: typeId("Republic Fleet EMP S"), chargeQuantity: 1 }], drones: [], cargo: [], skillProfile: { mode: "all5" }, damageProfile: { em: .25, thermal: .25, kinetic: .25, explosive: .25 }, ...extra });
const suggestion = (fit = base()) => ({ title: "Specific verified fitting", rationale: "Activate the selected autocannon with matching ammunition.", tradeoffs: ["Theoretical DPS is not applied damage."], slots: fit.slots.map(slot => ({ ...slot, state: "active", chargeTypeId: slot.chargeTypeId ?? null, chargeQuantity: slot.chargeTypeId ? 60 : null })), drones: fit.drones, cargo: fit.cargo });
const output = (items: unknown[] = [suggestion()]) => ({ summary: "Specific hull-preserving advice.", suggestions: items });
const mockProvider = (value: unknown = output()): FittingAdviceProvider => ({ isConfigured: () => true, generate: async () => ({ model: "mock-gpt-5.6", output: value, usage: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } }) });
const quote = async (fits: CanonicalFit[]): Promise<FittingAdvicePrice[]> => fits.map((_fit, index) => ({ estimatedTotalIsk: 100 + index * 20, complete: true, basis: "jita_sell", checkedAt: "2026-10-04T00:00:00.000Z", missingTypeIds: [], note: "Synthetic prices only; no market request." }));
const engine = { validateCanonicalFit, simulateWorkbench, exportEft };
const body = (fit = base(), extra: Record<string, unknown> = {}) => ({ fit, mode: "optimize", goal: "PvP autocannon fitting\nKeep finite ammunition", language: "en", ...extra });
const errorCode = (code: string) => (error: unknown) => error instanceof FittingWorkbenchError && error.code === code && !/private|secret|access-token|<html>/i.test(error.message);
function service(options: { provider?: FittingAdviceProvider; engine?: Pick<FittingWorkbenchEngine, "validateCanonicalFit" | "simulateWorkbench" | "exportEft">; resolveSkills?: (actor: FittingActor, fit: CanonicalFit) => Promise<FittingSkillContext>; quoteFits?: typeof quote; now?: () => number; timeoutMs?: number; limits?: { perMinute?: number; globalConcurrent?: number; maxWindowKeys?: number } } = {}) {
  return createFittingAdviceService({ engine, resolveSkills: async (_actor, fit) => ({ skillSource: { mode: fit.skillProfile.mode } }), provider: mockProvider(), quoteFits: quote, ...options });
}

test("AI output schema closes every object and requires nullable optional fields", () => {
  function check(value: unknown) {
    if (!value || typeof value !== "object") return;
    const schema = value as Record<string, unknown>;
    if (schema.type === "object") { assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, Object.keys(schema.properties as object)); }
    for (const nested of Object.values(schema)) if (Array.isArray(nested)) nested.forEach(check); else check(nested);
  }
  check(fittingAdviceOutputSchema);
});

test("missing provider configuration is explicit and costs no ESI, simulation or price work", async () => {
  let calls = 0;
  const unavailable = service({ provider: { isConfigured: () => false, generate: async () => { calls++; throw new Error("secret"); } }, resolveSkills: async () => { calls++; throw new Error("secret"); }, engine: { ...engine, simulateWorkbench: async () => { calls++; throw new Error("secret"); } }, quoteFits: async () => { calls++; throw new Error("secret"); } });
  await assert.rejects(unavailable.advise(actor, body()), errorCode("FITTING_AI_NOT_CONFIGURED")); assert.equal(calls, 0);
});

test("input rejects unknown context/skills, invalid mode, zero-length goal and bad budgets before provider", async () => {
  const s = service();
  for (const input of [body(base(), { mode: "auto" }), body(base(), { goal: " " }), body(base(), { goal: "x".repeat(501) }), body(base(), { goal: "\u0000" }), body(base(), { budgetIsk: -1 }), body(base(), { budgetIsk: Infinity }), body(base(), { budgetIsk: 1e14 }), body(base(), { skills: {} }), body(base(), { corporationId: 2002 }), null]) await assert.rejects(s.advise(actor, input), errorCode("FITTING_AI_INVALID_INPUT"));
});

test("OpenAI adapter bounds generation, storage and schema without real paid calls", async () => {
  let sent: Record<string, any> | undefined;
  const provider = createOpenAiFittingAdviceProvider({ getConfig: () => ({ apiKey: "synthetic-key-not-real" }), request: (async (_url, init) => {
    sent = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: JSON.stringify(output()) }] }], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }));
  }) as typeof fetch });
  const response = await provider.generate({ mode: "new", language: "en", goal: "PvE", budgetIsk: null, data: {}, safetyIdentifier: "opaque" }, new AbortController().signal);
  assert.equal(response.model, "gpt-5.6"); assert.equal(sent?.store, false); assert.equal(sent?.max_output_tokens, 8192); assert.equal(sent?.text.format.strict, true); assert.equal(sent?.tools, undefined); assert.equal(sent?.safety_identifier, "opaque");
  assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 20, totalTokens: 30 });
});

test("provider failure, refusal, incomplete, invalid JSON and too-large response are fixed safe errors", async () => {
  const cases: Array<[() => Response, string]> = [
    [() => new Response("private upstream access-token <html>", { status: 401 }), "FITTING_AI_UNAVAILABLE"],
    [() => new Response(JSON.stringify({ status: "incomplete", output: [], incomplete_details: { reason: "max_output_tokens" } })), "FITTING_AI_INCOMPLETE"],
    [() => new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "refusal", refusal: "private provider text" }] }] })), "FITTING_AI_REFUSED"],
    [() => new Response(JSON.stringify({ status: "completed", output: [{ content: [{ type: "output_text", text: "private invalid JSON" }] }] })), "FITTING_AI_INVALID_OUTPUT"],
    [() => new Response("x".repeat(256 * 1024 + 1)), "FITTING_AI_INVALID_OUTPUT"],
  ];
  for (const [reply, code] of cases) {
    const provider = createOpenAiFittingAdviceProvider({ getConfig: () => ({ apiKey: "synthetic" }), request: (async () => reply()) as typeof fetch });
    await assert.rejects(provider.generate({ mode: "optimize", language: "zh", goal: "test", budgetIsk: null, data: {}, safetyIdentifier: "opaque" }, new AbortController().signal), errorCode(code));
  }
  assert.equal(adviceError("FITTING_AI_private_secret").code, "FITTING_AI_UNAVAILABLE");
});

test("provider timeout aborts the request and does not leak network exceptions", async () => {
  const provider = createOpenAiFittingAdviceProvider({ getConfig: () => ({ apiKey: "synthetic" }), timeoutMs: 10, request: (async (_url, init) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("private access-token exception")), { once: true }))) as typeof fetch });
  await assert.rejects(provider.generate({ mode: "new", language: "zh", goal: "test", budgetIsk: null, data: {}, safetyIdentifier: "opaque" }, new AbortController().signal), errorCode("FITTING_AI_TIMEOUT"));
});

test("optimization uses real Dogma stats, explicit quantities, EFT and read-only changes", async () => {
  const fit = base(), original = structuredClone(fit);
  const result = await service().advise(actor, body(fit, { budgetIsk: 150 }));
  assert.deepEqual(fit, original); assert.equal(result.source, "openai"); assert.equal(result.suggestions.length, 1);
  const proposal = result.suggestions[0]!;
  assert.equal(proposal.dogmaVerified, true); assert.equal(proposal.simulation.valid, true); assert.ok(proposal.simulation.stats.offense.dps > 0); assert.equal(proposal.delta.dps, Math.round((proposal.simulation.stats.offense.dps - result.baselineSimulation.stats.offense.dps) * 10000) / 10000);
  assert.equal(proposal.fit.slots[0]!.chargeQuantity, 60); assert.equal(proposal.changes[0]!.before?.chargeQuantity, 1); assert.equal(proposal.changes[0]!.after?.chargeQuantity, 60);
  assert.equal(proposal.withinBudget, true); assert.ok(proposal.eft.includes("Rifter")); assert.ok(proposal.eftWarnings.length); assert.deepEqual(result.baselineSimulation.fit, validateCanonicalFit(fit));
});

test("new mode starts a fresh seed but preserves hull, skills, damage, implants and boosters", async () => {
  const fit = base({ implants: [{ typeId: typeId("High-grade Crystal Alpha") }], boosters: [{ typeId: typeId("Synth Blue Pill Booster") }], damageProfile: { em: 1, thermal: 0, kinetic: 0, explosive: 0 } });
  let prompt: FittingAdviceProviderInput | undefined;
  const provider = mockProvider(output([suggestion(fit)]));
  const s = service({ provider: { ...provider, generate: async (input, signal) => { prompt = input; return provider.generate(input, signal); } } });
  const result = await s.advise(actor, body(fit, { mode: "new" }));
  const seed = prompt!.data.seed as CanonicalFit;
  assert.deepEqual(seed.slots, []); assert.deepEqual(seed.drones, []); assert.deepEqual(seed.cargo, []);
  const proposed = result.suggestions[0]!.fit;
  assert.equal(proposed.shipTypeId, fit.shipTypeId); assert.deepEqual(proposed.skillProfile, fit.skillProfile); assert.deepEqual(proposed.damageProfile, fit.damageProfile); assert.deepEqual(proposed.implants, fit.implants); assert.deepEqual(proposed.boosters, fit.boosters);
  assert.ok(!JSON.stringify(prompt).includes(actor.userName)); assert.ok(!JSON.stringify(prompt).includes(fit.name));
  assert.equal(result.baselineSimulation.fit.slots.length, 1);
});

test("one actual-active skill snapshot is locked for baseline and each candidate", async () => {
  let skillReads = 0;
  const levels = Object.fromEntries(getFittingData().types.filter(type => type.categoryId === 16).map(type => [type.id, 5])); levels[3426] = 3;
  const used: Array<Record<number, number> | undefined> = [];
  const s = service({ resolveSkills: async () => { skillReads++; return { levels, skillSource: { mode: "character", characterId: 20, checkedAt: "2026-10-04T00:00:00.000Z" } }; }, engine: { ...engine, simulateWorkbench: async (fit, language, skills) => { used.push(skills); return simulateWorkbench(fit, language, skills); } } });
  const result = await s.advise(actor, body(base({ skillProfile: { mode: "character", characterId: 20 } })));
  assert.equal(skillReads, 1); assert.equal(used.length, 2); assert.equal(used[0], used[1]); assert.equal(used[0]![3426], 3); assert.equal(result.baselineSimulation.resources.cpu.limit, 149.5); assert.deepEqual(result.skillSource, result.suggestions[0]!.simulation.skillSource);
});

test("authorization errors do not fallback to all V or call AI", async () => {
  let providerCalls = 0;
  for (const code of ["SKILL_AUTHORIZATION_REQUIRED", "ESI_SKILLS_UNAVAILABLE", "FITTING_CHARACTER_NOT_FOUND"]) {
    const s = service({ resolveSkills: async () => { throw new FittingWorkbenchError(503, code, "private token-body"); }, provider: { isConfigured: () => true, generate: async () => { providerCalls++; throw new Error(); } } });
    await assert.rejects(s.advise(actor, body(base({ skillProfile: { mode: "character", characterId: 20 } }))), errorCode(code));
  }
  assert.equal(providerCalls, 0);
});

test("unknown IDs, cargo categories, bad ammo, duplicated slots and overloaded slots are never marked verified", async () => {
  const valid = suggestion();
  const invalid: unknown[] = [
    { ...valid, slots: [{ ...valid.slots[0]!, typeId: 2147483647 }] },
    { ...valid, slots: [{ ...valid.slots[0]!, typeId: typeId("Republic Fleet EMP S") }] },
    { ...valid, slots: [{ ...valid.slots[0]!, rack: "low" }] },
    { ...valid, slots: [{ ...valid.slots[0]!, index: 31 }] },
    { ...valid, slots: [valid.slots[0], valid.slots[0]] },
    { ...valid, slots: [{ ...valid.slots[0]!, chargeQuantity: null }] },
    { ...valid, slots: [{ ...valid.slots[0]!, chargeQuantity: 1_000_000 }] },
    { ...valid, slots: [{ ...valid.slots[0]!, state: "offline" }] },
    { ...valid, drones: [{ typeId: typeId("200mm AutoCannon II"), quantity: 1, activeQuantity: 1 }] },
    { ...valid, slots: [], cargo: [] },
  ];
  for (const item of invalid) await assert.rejects(service({ provider: mockProvider(output([item])) }).advise(actor, body()), errorCode("FITTING_AI_NO_VALID_SUGGESTIONS"));
  const result = await service({ provider: mockProvider(output([invalid[0], valid])) }).advise(actor, body());
  assert.equal(result.rejectedSuggestions, 1); assert.equal(result.suggestions.length, 1); assert.equal(result.suggestions[0]!.dogmaVerified, true);
});

test("false valid flag, resource overflow or silently downgraded states are rejected independently", async () => {
  for (const flag of ["valid", "cpu", "state"] as const) {
    const s = service({ engine: { ...engine, simulateWorkbench: async (fit, language, skills) => {
      const result = await simulateWorkbench(fit, language, skills);
      if (fit.slots[0]?.state === "active") {
        if (flag === "valid") result.valid = false;
        if (flag === "cpu") result.resources.cpu.overloaded = true;
        if (flag === "state") result.moduleStates[0]!.state = "online";
      }
      return result;
    } } });
    await assert.rejects(s.advise(actor, body()), errorCode("FITTING_AI_NO_VALID_SUGGESTIONS"));
  }
});

test("missing prices are unknown, above-budget prices explicit and zero budget preserved", async () => {
  const missing = await service({ quoteFits: async fits => (await quote(fits)).map(price => ({ ...price, complete: false, estimatedTotalIsk: null, missingTypeIds: [typeId("Rifter")] })) }).advise(actor, body(base(), { budgetIsk: 150 }));
  assert.equal(missing.suggestions[0]!.price.estimatedTotalIsk, null); assert.equal(missing.suggestions[0]!.withinBudget, null); assert.ok(missing.suggestions[0]!.warnings.length);
  const expensive = await service().advise(actor, body(base(), { budgetIsk: 0 })); assert.equal(expensive.suggestions[0]!.withinBudget, false);
  const failed = await service({ quoteFits: async () => { throw new Error("private market body"); } }).advise(actor, body(base(), { budgetIsk: 150 }));
  assert.equal(failed.suggestions[0]!.withinBudget, null); assert.ok(!JSON.stringify(failed).includes("private market body"));
});

test("candidate catalog is bounded/public and includes common light/medium drone families", async () => {
  const fit = base({ shipTypeId: typeId("Vexor") }), simulation = await simulateWorkbench(fit, "en");
  const candidates = buildFittingAdviceCandidates(fit, simulation);
  assert.ok(candidates.length <= 180); assert.ok(candidates.every(type => type.published));
  for (const name of ["Hobgoblin I", "Hobgoblin II", "Warrior I", "Warrior II", "Hammerhead I", "Hammerhead II"]) assert.ok(candidates.some(type => type.name.en === name), name);
});

test("duplicate baseline drones/cargo are aggregated and charge-only changes remain visible", () => {
  const a = base({ drones: [{ typeId: typeId("Hobgoblin I"), quantity: 2, activeQuantity: 1 }, { typeId: typeId("Hobgoblin I"), quantity: 3, activeQuantity: 2 }], cargo: [{ typeId: typeId("Tritanium"), quantity: 2 }, { typeId: typeId("Tritanium"), quantity: 3 }] });
  const b = base({ drones: [{ typeId: typeId("Hobgoblin I"), quantity: 4, activeQuantity: 2 }], cargo: [{ typeId: typeId("Tritanium"), quantity: 4 }] });
  const changes = fittingAdviceChanges(a, b, "en"); assert.equal(changes.find(change => change.section === "drone")!.before!.quantity, 5); assert.equal(changes.find(change => change.section === "drone")!.before!.activeQuantity, 3); assert.equal(changes.find(change => change.section === "cargo")!.before!.quantity, 5);
});

test("per-process rate windows and bounded concurrency reject overlap then recover", async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const provider: FittingAdviceProvider = { isConfigured: () => true, generate: async () => { started(); await blocked; return { model: "mock", output: output(), usage: null }; } };
  let clock = 1000;
  const s = service({ provider, now: () => clock, limits: { globalConcurrent: 1, perMinute: 1 } });
  const first = s.advise(actor, body()); await began;
  await assert.rejects(s.advise({ ...actor, userId: 3 }, body()), errorCode("FITTING_AI_BUSY"));
  await assert.rejects(s.advise(actor, body()), errorCode("FITTING_AI_RATE_LIMIT"));
  release(); await first;
  await assert.rejects(s.advise(actor, body()), errorCode("FITTING_AI_RATE_LIMIT"));
  clock += 60_000; assert.equal((await s.advise(actor, body())).source, "openai");
});

test("total deadline releases concurrency even when injected provider ignores AbortSignal", async () => {
  const baseline = await simulateWorkbench(base(), "en");
  const s = service({ timeoutMs: 15, engine: { ...engine, simulateWorkbench: async () => structuredClone(baseline) }, provider: { isConfigured: () => true, generate: async () => new Promise(() => undefined) } });
  await assert.rejects(s.advise(actor, body()), errorCode("FITTING_AI_TIMEOUT"));
  await assert.rejects(s.advise(actor, body()), errorCode("FITTING_AI_TIMEOUT"));
});

test("real Express advice inherits auth/tenant/fleet, owns characters, and never stores suggested fits", async () => {
  const queries: string[] = [];
  const fixture = await createFittingWorkbenchFixture({ adviceProvider: mockProvider(), adviceQuotes: quote, adviceLimits: { perMinute: 10 }, logQuery: query => queries.push(query) });
  const { server, url } = await fixture.listen();
  const request = (user: number, data = body()) => fetch(`${url}/api/fitting/advice`, { method: "POST", headers: { "x-test-user": String(user), "content-type": "application/json" }, body: JSON.stringify(data) });
  try {
    assert.equal((await request(999)).status, 401);
    for (const characterId of [30, 40, 22, 23]) {
      const response = await request(2, body(base({ skillProfile: { mode: "character", characterId } })));
      assert.equal(response.status, 404); assert.equal((await response.json() as { code: string }).code, "FITTING_CHARACTER_NOT_FOUND");
    }
    const response = await request(2); assert.equal(response.status, 200); const result = await response.json() as FittingAdviceResponse; assert.equal(result.source, "openai"); assert.equal(result.suggestions[0]!.dogmaVerified, true);
    assert.equal((await fixture.pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM fittings")).rows[0]!.count, 0);
    assert.deepEqual((await fixture.pg.query<{ total_pap: number; redeemable_pap: number }>("SELECT total_pap,redeemable_pap FROM users WHERE id=2")).rows, [{ total_pap: 12, redeemable_pap: 12 }]);
    assert.ok(queries.every(query => !/^(insert|update|delete)\s/iu.test(query)));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close(); }
});

test("loaded ammo is bounded by real magazine capacity rather than unlimited supply", async () => {
  const fit = base(), item = suggestion(fit); item.slots[0]!.chargeQuantity = 120;
  const valid = await service({ provider: mockProvider(output([item])) }).advise(actor, body(fit));
  assert.equal(valid.suggestions[0]!.fit.slots[0]!.chargeQuantity, 120);
  item.slots[0]!.chargeQuantity = 121;
  await assert.rejects(service({ provider: mockProvider(output([item])) }).advise(actor, body(fit)), errorCode("FITTING_AI_NO_VALID_SUGGESTIONS"));
});

test("from-zero attack battlecruisers and bombers retain role weapons and compatible ammo", async () => {
  for (const [hull, hardpoint] of [["Oracle", "turret"], ["Talos", "turret"], ["Tornado", "turret"], ["Naga", "turret"], ["Manticore", "launcher"]] as const) {
    const fit = base({ shipTypeId: typeId(hull), slots: [], drones: [], cargo: [] }), simulation = await simulateWorkbench(fit, "en"), candidates = buildFittingAdviceCandidates(fit, simulation);
    const weapons = candidates.filter(type => type.hardpoint === hardpoint && (hull === "Manticore" ? /Torpedo Launcher/u.test(type.name.en) : type.attributes.chargeSize === 3));
    assert.ok(weapons.length > 0, `${hull}: correct role weapons must be offered`);
    for (const weapon of weapons) {
      const groups = [1, 2, 3, 4, 5].map(index => weapon.attributes[`chargeGroup${index}`]).filter(Boolean);
      assert.ok(candidates.some(charge => charge.slot === "charge" && groups.includes(charge.groupId) && (!weapon.attributes.chargeSize || !charge.attributes.chargeSize || weapon.attributes.chargeSize === charge.attributes.chargeSize)), `${hull}: ${weapon.name.en} compatible charge`);
    }
    assert.ok(candidates.length <= 180);
  }
});

test("T3 candidate subsystems are complete families for this hull, never another hull", async () => {
  const fit = base({ shipTypeId: typeId("Tengu"), slots: [] }), simulation = await simulateWorkbench(fit, "en"), candidates = buildFittingAdviceCandidates(fit, simulation);
  const subsystems = candidates.filter(type => type.slot === "subsystem");
  assert.equal(subsystems.length, 12); assert.ok(subsystems.every(type => type.attributes.fitsToShipType === fit.shipTypeId)); assert.equal(new Set(subsystems.map(type => type.attributes.subSystemSlot)).size, 4);
});

test("external cancellation aborts provider, skips quote work and releases concurrency", async () => {
  let calls = 0, quotes = 0, started!: () => void, observed!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), aborted = new Promise<void>(resolve => { observed = resolve; });
  const controller = new AbortController();
  const provider: FittingAdviceProvider = { isConfigured: () => true, generate: async (_input, signal) => {
    calls++; if (calls > 1) return { model: "mock", output: output(), usage: null };
    started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { observed(); reject(new Error("private network body")); }, { once: true }));
  } };
  const s = service({ provider, limits: { globalConcurrent: 1 }, quoteFits: async fits => { quotes++; return quote(fits); } });
  const pending = s.advise(actor, body(), controller.signal); await began; controller.abort();
  await assert.rejects(pending, errorCode("FITTING_AI_TIMEOUT")); await aborted; assert.equal(quotes, 0);
  assert.equal((await s.advise(actor, body())).source, "openai"); assert.equal(quotes, 1);
  await assert.rejects(s.advise(actor, body(), AbortSignal.abort()), errorCode("FITTING_AI_TIMEOUT")); assert.equal(calls, 2);
});

test("Express disconnect forwards cancellation and fleet-disabled requests never reach provider", async () => {
  let calls = 0, quotes = 0, started!: () => void, observed!: () => void;
  const began = new Promise<void>(resolve => { started = resolve; }), aborted = new Promise<void>(resolve => { observed = resolve; });
  const provider: FittingAdviceProvider = { isConfigured: () => true, generate: async (_input, signal) => {
    calls++; started(); return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { observed(); reject(new Error("private network body")); }, { once: true }));
  } };
  const fixture = await createFittingWorkbenchFixture({ adviceProvider: provider, adviceQuotes: async fits => { quotes++; return quote(fits); } }), { server, url } = await fixture.listen();
  try {
    const controller = new AbortController(), pending = fetch(`${url}/api/fitting/advice`, { method: "POST", signal: controller.signal, headers: { "x-test-user": "2", "content-type": "application/json" }, body: JSON.stringify(body()) });
    await began; controller.abort(); await assert.rejects(pending);
    await Promise.race([aborted, new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP close did not abort provider")), 1000))]);
    assert.equal(quotes, 0); assert.equal((await fixture.pg.query<{ count: number }>("SELECT count(*)::integer AS count FROM fittings")).rows[0]!.count, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await fixture.close(); }
  const disabled = await createFittingWorkbenchFixture({ adviceProvider: provider, fleetEnabled: false }), disabledHttp = await disabled.listen();
  try {
    const response = await fetch(`${disabledHttp.url}/api/fitting/advice`, { method: "POST", headers: { "x-test-user": "2", "content-type": "application/json" }, body: JSON.stringify(body()) });
    assert.equal(response.status, 404); assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => disabledHttp.server.close(() => resolve())); await disabled.close(); }
});
