import { parentPort, workerData } from "node:worker_threads";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import type { Fit, Calculation } from "@eveshipfit/dogma-engine";

interface EngineJob { id: number; action: "calculate" | "loadEft" | "saveEft"; fit?: Fit; text?: string }
const paths = workerData as { engineEntry: string; wasmPath: string; sdePath: string; namesPath: string; expectedBuild: number };
const ready = (async () => {
  const engine = await import(pathToFileURL(paths.engineEntry).href) as typeof import("@eveshipfit/dogma-engine");
  await engine.default({ module_or_path: await readFile(paths.wasmPath) });
  const build = engine.load_sde(await readFile(paths.sdePath));
  if (build !== paths.expectedBuild) throw new Error("Fitting engine and catalog SDE versions differ");
  engine.load_names(await readFile(paths.namesPath));
  return engine;
})();

parentPort?.on("message", async (job: EngineJob) => {
  try {
    const engine = await ready;
    let result: Fit | Calculation | string;
    if (job.action === "loadEft") result = engine.load_eft(job.text ?? "");
    else if (job.action === "saveEft") result = engine.save_eft(job.fit!);
    else result = engine.calculate(job.fit!, { validate: true });
    parentPort?.postMessage({ id: job.id, result });
  } catch (error) {
    parentPort?.postMessage({ id: job.id, error: error instanceof Error ? error.message : "Fitting calculation failed" });
  }
});
