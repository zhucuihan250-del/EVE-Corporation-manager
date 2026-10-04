import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createDutyPapJobRunner } from "./duty-pap-jobs";
import type { DutyPapObservation } from "./duty-pap-collector";

type JobOptions = Parameters<typeof createDutyPapJobRunner>[0];
function fixture(options: { locked?: boolean; connections?: number; collect?: JobOptions["collector"]["collect"] } = {}) {
  const queries: string[] = [], calls: number[] = [], applied: number[] = [], clients: (EventEmitter & { releaseCount: number })[] = [];
  const rows = Array.from({ length: options.connections ?? 1 }, (_, index) => ({ id: index + 1, version: 0, corporationId: 1001, userId: index + 1, characterId: index + 10, eveCharacterId: index + 100, accessToken: "test", refreshToken: "test", tokenExpiry: new Date(Date.now() + 3_600_000), scopes: [] }));
  const pool = { async connect() { const client = Object.assign(new EventEmitter(), { releaseCount: 0, async query(text: string) { queries.push(text); return { rows: [{ locked: options.locked ?? true }] }; }, release() { this.releaseCount++; } }); clients.push(client); return client; } } as unknown as JobOptions["pool"];
  const service = { async listCollectableConnections() { return rows; }, async processObservation(id: number) { applied.push(id); return {}; } } as unknown as JobOptions["service"];
  const observe: DutyPapObservation = { observedAt: new Date(), evidenceAt: null, valid: false, status: "unavailable", eveFleetId: null, corporationId: null, online: null, solarSystemId: null, shipTypeId: null, docked: null };
  const collector = { async collect(row: Parameters<JobOptions["collector"]["collect"]>[0], options: Parameters<JobOptions["collector"]["collect"]>[1]) { calls.push(row.characterId); return options?.signal?.aborted ? observe : await (optionsCollect ? optionsCollect(row, options) : Promise.resolve(observe)); } };
  const optionsCollect = options.collect;
  return { runner: createDutyPapJobRunner({ service, collector, pool }), queries, calls, applied, clients };
}
test("a dedicated PostgreSQL session lock covers complete sweep and is always released", async () => {
  const f = fixture({ connections: 6 }), result = await f.runner.runOnce();
  assert.equal(result.collected, 6); assert.equal(f.applied.length, 6);
  assert.equal(f.queries[0]!.includes("pg_try_advisory_lock"), true); assert.equal(f.queries.at(-1)!.includes("pg_advisory_unlock"), true);
  assert.equal(f.clients[0]!.releaseCount, 1);
});
test("another instance owning the lock skips every ESI read and releases its unused session", async () => {
  const f = fixture({ locked: false }), result = await f.runner.runOnce();
  assert.equal(result.skipped, true); assert.equal(f.calls.length, 0); assert.equal(f.applied.length, 0); assert.equal(f.clients[0]!.releaseCount, 1);
  assert.equal(f.queries.some(text => text.includes("pg_advisory_unlock")), false);
});
test("no local overlapping sweep, stop aborts pending observations and prevents any commit", async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; });
  const f = fixture({ collect: async (_connection, options) => new Promise<DutyPapObservation>(resolve => { began(); options?.signal?.addEventListener("abort", () => resolve({ observedAt: new Date(), evidenceAt: null, valid: false, status: "unavailable", eveFleetId: null, corporationId: null, online: null, solarSystemId: null, shipTypeId: null, docked: null }), { once: true }); }) });
  const first = f.runner.runOnce(); await started;
  assert.equal((await f.runner.runOnce()).skipped, true); await f.runner.stop(); await first;
  assert.equal(f.applied.length, 0); assert.equal((await f.runner.runOnce()).skipped, true); assert.equal(f.clients[0]!.releaseCount, 1);
});
test("lost advisory session aborts that run; later runs use a fresh controller and can recover", async () => {
  let began!: () => void; const started = new Promise<void>(resolve => { began = resolve; }); let call = 0;
  const observation: DutyPapObservation = { observedAt: new Date(), evidenceAt: null, valid: false, status: "unavailable", eveFleetId: null, corporationId: null, online: null, solarSystemId: null, shipTypeId: null, docked: null };
  const f = fixture({ collect: async (_connection, options) => { if (call++ > 0) return observation; return new Promise<DutyPapObservation>(resolve => { began(); options?.signal?.addEventListener("abort", () => resolve(observation), { once: true }); }); } });
  const first = f.runner.runOnce(); await started; f.clients[0]!.emit("error", new Error("session lost")); await first;
  assert.equal(f.applied.length, 0); assert.equal((await f.runner.runOnce()).collected, 1); assert.equal(f.applied.length, 1);
});
