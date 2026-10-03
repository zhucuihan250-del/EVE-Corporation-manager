import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A reproducible metadata subset, not redistributed meshes or community models.
const zip = process.argv[2];
if (!zip) throw new Error("Usage: build-eve-fitting-models.ts <official SDE JSONL ZIP>");
function table(name: string): any[] {
  const result = spawnSync("unzip", ["-p", zip, `${name}.jsonl`], { encoding: "utf8", maxBuffer: 150 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`Cannot read ${name}`);
  return result.stdout.trim().split("\n").map(line => JSON.parse(line));
}
const graphics = new Map(table("graphics").map(row => [row._key, row]));
const groups = new Map(table("groups").map(row => [row._key, row]));
const types: Record<number, object> = {};
for (const row of table("types")) {
  const category = groups.get(row.groupID)?.categoryID;
  if (!row.published || ![6, 7, 32, 65, 66, 87].includes(category)) continue;
  const graphic = graphics.get(row.graphicID);
  if (!graphic) continue;
  const { sofHullName, sofFactionName, sofRaceName, graphicFile } = graphic;
  const dna = sofHullName && sofFactionName && sofRaceName
    ? `${sofHullName}:${sofFactionName}:${sofRaceName}`.toLowerCase() : null;
  if (!dna && !graphicFile) continue;
  types[row._key] = { graphicId: row.graphicID, categoryId: category, groupId: row.groupID,
    dna, resourcePath: graphicFile?.replace(/\.red$/i, ".black") ?? null };
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const output = path.join(root, "artifacts/api-server/src/data/eve-fitting-models.json");
await writeFile(output, JSON.stringify({ sdeBuildNumber: 3561556, source: "CCP official JSONL SDE", types }));
console.log(`Generated ${Object.keys(types).length} fitting model records`);
