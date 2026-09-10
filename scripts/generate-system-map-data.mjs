import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [systemsPath, stargatesPath, outputPath, buildNumber = "unknown"] =
  process.argv.slice(2);

if (!systemsPath || !stargatesPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/generate-system-map-data.mjs <mapSolarSystems.jsonl> <mapStargates.jsonl> <output.ts> [build]",
  );
}

const [systemsInput, stargatesInput] = await Promise.all([
  readFile(systemsPath, "utf8"),
  readFile(stargatesPath, "utf8"),
]);

const systems = systemsInput
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    const entry = JSON.parse(line);
    const id = Number(entry._key);
    const name = entry?.name?.en;
    const values = [
      entry?.position2D?.x,
      entry?.position2D?.y,
      entry?.position?.x,
      entry?.position?.y,
      entry?.position?.z,
      entry?.securityStatus,
    ].map(Number);
    return Number.isInteger(id) &&
      id >= 30_000_000 &&
      id <= 30_999_999 &&
      typeof name === "string" &&
      name &&
      values.every(Number.isFinite)
      ? [[id, name, ...values]]
      : [];
  })
  .sort((left, right) => left[0] - right[0]);

const systemIds = new Set(systems.map(([id]) => id));
const edgesByKey = new Map();
for (const line of stargatesInput.split("\n").filter(Boolean)) {
  const entry = JSON.parse(line);
  const from = Number(entry?.solarSystemID);
  const to = Number(entry?.destination?.solarSystemID);
  if (!systemIds.has(from) || !systemIds.has(to) || from === to) continue;
  const [first, second] = [from, to].sort((left, right) => left - right);
  edgesByKey.set(`${first}:${second}`, [first, second]);
}
const edges = [...edgesByKey.values()].sort(
  (left, right) => left[0] - right[0] || left[1] - right[1],
);

const source =
  `// Generated from CCP EVE Online Static Data Export build ${buildNumber}.\n` +
  `// Source: https://developers.eveonline.com/static-data/\n` +
  `export type EveSystemMapRecord = readonly [solarSystemId: number, solarSystemName: string, mapX: number, mapY: number, x: number, y: number, z: number, securityStatus: number];\n` +
  `export const eveSystemMapNodes: ReadonlyArray<EveSystemMapRecord> = ${JSON.stringify(systems)};\n` +
  `export const eveSystemMapEdges: ReadonlyArray<readonly [number, number]> = ${JSON.stringify(edges)};\n`;

await writeFile(path.resolve(outputPath), source, "utf8");
console.log(
  `Generated ${systems.length} map systems and ${edges.length} stargate connections at ${outputPath}`,
);
