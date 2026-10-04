import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyFit, fitKey } from "./fitting-workbench-presentation";
import {
  createAdviceRequestGate,
  fittingAdviceContextKey,
  fittingAdviceErrorText,
  parseFittingAdviceBudget,
  snapshotFittingAdvice,
  validateFittingAdviceResponse,
} from "./fitting-ai-advice";
import type { FittingAdviceRequest } from "./fitting-workbench-types";

test("advice snapshots never modify live modules, charges, skills or bay entries", () => {
  const fit = emptyFit(587, "Read-only draft");
  fit.slots = [{ rack: "high", index: 0, typeId: 2881, state: "active", chargeTypeId: 185 }];
  fit.drones = [{ typeId: 2456, quantity: 2, activeQuantity: 1 }];
  fit.cargo = [{ typeId: 34, quantity: 10 }];
  fit.skillProfile = { mode: "character", characterId: 20 };
  const before = fitKey(fit);
  const snapshot = snapshotFittingAdvice(fit, "1001:2", "zh");
  snapshot.fit.slots[0].typeId = 1;
  snapshot.fit.drones[0].quantity = 9;
  snapshot.fit.cargo[0].quantity = 99;
  snapshot.fit.skillProfile.characterId = 21;
  snapshot.fit.damageProfile.em = 90;
  assert.equal(fitKey(fit), before);
  assert.equal(snapshot.contextKey, fittingAdviceContextKey(fit, "1001:2", "zh"));
});

test("late results cannot commit under changed fit, actor, corporation or language", () => {
  const fit = emptyFit(587, "Snapshot");
  const snapshot = snapshotFittingAdvice(fit, "1001:2", "zh");
  const gate = createAdviceRequestGate();
  const ticket = gate.begin(snapshot);
  assert.equal(gate.isCurrent(ticket, snapshot.contextKey), true);
  for (const context of [
    fittingAdviceContextKey({ ...fit, name: "Changed" }, "1001:2", "zh"),
    fittingAdviceContextKey(fit, "1001:5", "zh"),
    fittingAdviceContextKey(fit, "1002:2", "zh"),
    fittingAdviceContextKey(fit, "1001:2", "en"),
    fittingAdviceContextKey({ ...fit, skillProfile: { mode: "none" } }, "1001:2", "zh"),
  ]) assert.equal(gate.isCurrent(ticket, context), false);
});

test("cancel, close, unmount, staleness and timeout all abort and invalidate a request", () => {
  const snapshot = snapshotFittingAdvice(emptyFit(587), "1001:2", "zh");
  for (const reason of ["cancelled", "closed", "unmounted", "stale", "timeout"] as const) {
    const gate = createAdviceRequestGate();
    const ticket = gate.begin(snapshot);
    assert.equal(gate.cancelTicket(ticket, reason), true);
    assert.equal(ticket.reason, reason);
    assert.equal(ticket.controller.signal.aborted, true);
    assert.equal(gate.isCurrent(ticket, snapshot.contextKey), false);
  }
});

test("superseded requests and old timers cannot cancel or finish the latest request", () => {
  const snapshot = snapshotFittingAdvice(emptyFit(587), "1001:2", "zh");
  const gate = createAdviceRequestGate();
  const old = gate.begin(snapshot);
  const latest = gate.begin(snapshot);
  assert.equal(old.reason, "superseded");
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(gate.cancelTicket(old, "timeout"), false);
  gate.finish(old);
  assert.equal(gate.isCurrent(latest, snapshot.contextKey), true);
  gate.finish(latest);
  assert.equal(gate.isCurrent(latest, snapshot.contextKey), false);
});

test("HTML errors and token-shaped diagnostics are never shown in advice UI", () => {
  for (const message of ["<html><body>502 upstream</body></html>", "Authorization: Bearer abc", "api_key=secret", "access_token: secret", "x".repeat(2001)]) {
    const error = fittingAdviceErrorText(new Error(message), true);
    assert.equal(error.includes(message), false);
    assert.equal(error.includes("当前配装未改变"), true);
  }
  assert.equal(fittingAdviceErrorText(new Error("请重新授权本人角色技能。"), true), "请重新授权本人角色技能。");
  assert.equal(fittingAdviceErrorText(Object.assign(new Error("internal configuration missing"), { code: "FITTING_AI_NOT_CONFIGURED" }), true), "配船 AI 尚未配置，请联系管理员。");
  assert.equal(fittingAdviceErrorText(Object.assign(new Error("internal provider timeout"), { code: "FITTING_AI_TIMEOUT" }), false), "Advice generation timed out. Retry; your fitting is unchanged.");
});

test("optional budgets accept explicit zero and reject malformed or out-of-range amounts", () => {
  assert.equal(parseFittingAdviceBudget("  "), undefined);
  assert.equal(parseFittingAdviceBudget("0"), 0);
  assert.equal(parseFittingAdviceBudget("50000000.25"), 50000000.25);
  assert.equal(parseFittingAdviceBudget("10000000000000"), 1e13);
  for (const input of ["-1", "1e8", "Infinity", "NaN", "10000000000001", "0.001", "50,000,000", "<script>"])
    assert.equal(parseFittingAdviceBudget(input), null, input);
});

function responseFixture() {
  const fit = emptyFit(587, "Read-only fixture");
  fit.slots = [{ rack: "high", index: 0, typeId: 2881, state: "active", chargeTypeId: 185, chargeQuantity: 20 }];
  const request: FittingAdviceRequest = { fit, mode: "optimize", goal: "solo roaming", language: "en" };
  const price = { estimatedTotalIsk: 100, complete: true, basis: "jita_sell", checkedAt: "2026-10-04T01:00:00Z", missingTypeIds: [], note: "All recorded items included" };
  const skillSource = { mode: "all5" };
  const simulation = {
    fit: JSON.parse(JSON.stringify(fit)), valid: true, skillSource,
    ship: { typeId: 587, name: "Rifter" }, modules: [{ typeId: 2881, name: "Small gun" }], violations: [], limitations: [],
    resources: { cpu: { used: 1, limit: 10, percent: 10 }, powergrid: { used: 2, limit: 10, percent: 20 }, calibration: { used: 0, limit: 400, percent: 0 } },
    stats: { offense: { dps: 100, sustainedDps: 90 }, defense: { ehp: 1000 }, navigation: { speed: 300, alignSeconds: 3 }, capacitor: { usage: 1, stablePercent: 50, stable: true, secondsToEmpty: null } },
  };
  const response = {
    source: "openai", mode: "optimize", model: "test-fixture", generatedAt: "2026-10-04T01:00:00Z", summary: "Specific advice", skillSource,
    baselineSimulation: simulation, baselinePrice: price, rejectedSuggestions: 0, usage: null, warnings: [],
    suggestions: [{
      id: "one", title: "Close range", rationale: "Tackle and mobile defense", tradeoffs: ["Limited projection"], fit: JSON.parse(JSON.stringify(fit)), simulation: JSON.parse(JSON.stringify(simulation)),
      dogmaVerified: true, changes: [{ section: "slot", rack: "high", index: 0, before: null, after: { typeId: 2881, name: "Small gun", quantity: 1, chargeTypeId: 185, chargeName: "EMP S", chargeQuantity: 20, state: "active", activeQuantity: null } }],
      delta: { dps: 0, sustainedDps: 0, ehp: 0, speed: 0, alignSeconds: 0, cpuLoad: 0, powergridLoad: 0 },
      price, withinBudget: null, eft: "[Rifter, Close range]\nSmall gun, EMP S", eftWarnings: [], warnings: [],
    }],
  };
  return { request, response };
}

test("verified advice accepts both modes without changing the original fit", () => {
  for (const mode of ["optimize", "new"] as const) {
    const { request, response } = responseFixture();
    request.mode = mode;
    response.mode = mode;
    const before = fitKey(request.fit);
    assert.equal(validateFittingAdviceResponse(response, request), true);
    assert.equal(fitKey(request.fit), before);
  }
});

test("untrusted suggestions fail closed for invalid items, fits, skills or price claims", () => {
  const { request, response } = responseFixture();
  const changes: Array<(value: any) => void> = [
    value => { value.source = "rules"; },
    value => { value.suggestions = []; },
    value => { value.suggestions[0].dogmaVerified = false; },
    value => { value.suggestions[0].simulation.valid = false; },
    value => { value.suggestions[0].changes = [null]; },
    value => { value.suggestions[0].changes[0].rack = "unknown"; },
    value => { value.suggestions[0].changes[0].after.name = {}; },
    value => { value.suggestions[0].changes[0].after.chargeQuantity = -1; },
    value => { value.suggestions[0].simulation.ship = null; },
    value => { value.suggestions[0].simulation.modules = [null]; },
    value => { value.suggestions[0].delta.dps = Infinity; },
    value => { value.suggestions[0].fit.shipTypeId = 588; },
    value => { value.suggestions[0].fit.slots[0].typeId = 1; },
    value => { value.suggestions[0].fit.skillProfile.mode = "none"; },
    value => { value.suggestions[0].fit.damageProfile.em = 100; },
    value => { value.suggestions[0].simulation.skillSource.mode = "none"; },
    value => { value.baselineSimulation.skillSource.mode = "none"; },
    value => { value.suggestions[0].fit.implants = [{ typeId: 9943 }]; },
    value => { value.suggestions[0].price.complete = false; },
    value => { value.suggestions[0].withinBudget = true; },
  ];
  for (const change of changes) {
    const mutated = structuredClone(response);
    change(mutated);
    assert.equal(validateFittingAdviceResponse(mutated, request), false);
  }
  const incomplete = structuredClone(response);
  incomplete.suggestions[0].price = { ...incomplete.suggestions[0].price, estimatedTotalIsk: null as any, complete: false, missingTypeIds: [185] as any };
  assert.equal(validateFittingAdviceResponse(incomplete, { ...request, budgetIsk: 500 }), true);
  incomplete.suggestions[0].withinBudget = true as any;
  assert.equal(validateFittingAdviceResponse(incomplete, { ...request, budgetIsk: 500 }), false);
});

test("a timed-out transport that resolves late cannot publish or overwrite any live fit", async () => {
  const fit = emptyFit(587, "Live fit");
  const before = fitKey(fit);
  const snapshot = snapshotFittingAdvice(fit, "1001:2", "en");
  const gate = createAdviceRequestGate();
  const ticket = gate.begin(snapshot);
  let resolve!: (value: string) => void;
  const transport = new Promise<string>(done => { resolve = done; });
  let displayed: string | null = null;
  const pending = transport.then(value => { if (gate.isCurrent(ticket, snapshot.contextKey)) displayed = value; });
  gate.cancelTicket(ticket, "timeout");
  resolve("late advice");
  await pending;
  assert.equal(displayed, null);
  assert.equal(fitKey(fit), before);
});
