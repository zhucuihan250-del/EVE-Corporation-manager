import type { db } from "@workspace/db";
import { createDutyPapService, type DutyPapService } from "./duty-pap-service";
import { createDutyPapCollector, type DutyPapCollector } from "./duty-pap-collector";
import { DUTY_PAP_POLL_MS } from "./duty-pap-rules";

const DUTY_LOCK_KEY = 3360137;
type JobLogger = { info?: (value: unknown, message?: string) => void; warn?: (value: unknown, message?: string) => void };
// Structural types keep the API package independent of a direct pg dependency.
type JobClient = { query(text: string, values: number[]): Promise<{ rows: Record<string, unknown>[] }>; on(event: "error" | "end", listener: () => void): unknown; off(event: "error" | "end", listener: () => void): unknown; release(): void };
type JobPool = { connect(): Promise<JobClient> };
export function createDutyPapJobRunner({ service, collector, pool, logger }: { service: DutyPapService; collector: DutyPapCollector; pool: JobPool; logger?: JobLogger }) {
  let stopped = false, running: Promise<{ skipped: boolean; collected: number; failed: number }> | null = null;
  let activeController: AbortController | undefined;
  const execute = async () => {
    const abortController = new AbortController(); activeController = abortController;
    let client: JobClient | undefined, ownsLock = false, collected = 0, failed = 0;
    const lostLock = () => abortController.abort();
    try {
      if (stopped) return { skipped: true, collected, failed };
      client = await pool.connect();
      client.on("error", lostLock); client.on("end", lostLock);
      const result = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [DUTY_LOCK_KEY]);
      ownsLock = result.rows[0]?.locked === true;
      if (!ownsLock || stopped) return { skipped: true, collected, failed };
      const rows = await service.listCollectableConnections();
      let next = 0;
      // A lost dedicated lock connection aborts all in-flight reads. Never keep
      // sampling after another instance may have taken over the session lock.
      await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
          while (!stopped && !abortController.signal.aborted && next < rows.length) {
            const row = rows[next++]!;
            try {
              const observation = await collector.collect(row, { signal: abortController.signal });
              if (stopped || abortController.signal.aborted) break;
              await service.processObservation(row.id, row.version, observation);
              collected++;
              if (observation.status === "rate_limited") abortController.abort();
            } catch { failed++; /* No exception body, identifiers or tokens enter logs. */ }
          }
        }));
      if (failed) logger?.warn?.({ failed, collected }, "Duty PAP sweep completed with unavailable observations");
      return { skipped: false, collected, failed };
    } catch {
      logger?.warn?.({ collected, failed: failed + 1 }, "Duty PAP sweep unavailable");
      return { skipped: false, collected, failed: failed + 1 };
    } finally {
      if (client) {
        try { if (ownsLock) await client.query("SELECT pg_advisory_unlock($1)", [DUTY_LOCK_KEY]); }
        catch { /* A lost PostgreSQL session has already released its lock. */ }
        client.off("error", lostLock); client.off("end", lostLock); client.release();
      }
      if (activeController === abortController) activeController = undefined;
    }
  };
  return {
    runOnce() {
      if (running) return Promise.resolve({ skipped: true, collected: 0, failed: 0 });
      running = execute().finally(() => { running = null; });
      return running;
    },
    async stop() { stopped = true; activeController?.abort(); await running; },
  };
}
export function startDutyPapJobs({ database, pool, logger }: { database: typeof db; pool: JobPool; logger?: JobLogger }) {
  const runner = createDutyPapJobRunner({ service: createDutyPapService({ database }), collector: createDutyPapCollector(), pool, logger });
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined;
  const tick = async () => {
    if (stopped) return;
    await runner.runOnce();
    if (!stopped) { timer = setTimeout(() => { void tick(); }, DUTY_PAP_POLL_MS); timer.unref(); }
  };
  // No rules or connections are enabled by installation; there is no rollout
  // sweep and no historical backfill. Polling begins only after one interval.
  timer = setTimeout(() => { void tick(); }, DUTY_PAP_POLL_MS); timer.unref();
  logger?.info?.({ pollIntervalSeconds: DUTY_PAP_POLL_MS / 1000 }, "Duty PAP polling scheduled");
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); await runner.stop(); } };
}
