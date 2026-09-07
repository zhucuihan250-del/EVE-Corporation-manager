import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const [inputPath, outputPath, buildNumber = "unknown"] = process.argv.slice(2);

if (!inputPath || !outputPath) {
  throw new Error(
    "Usage: node scripts/generate-solar-system-catalog.mjs <mapSolarSystems.jsonl> <output.ts> [build]",
  );
}

const input = await readFile(inputPath, "utf8");
const systems = input
  .split("\n")
  .filter(Boolean)
  .flatMap((line) => {
    const entry = JSON.parse(line);
    const id = Number(entry._key);
    const name = entry?.name?.en;
    return Number.isInteger(id) && typeof name === "string" && name
      ? [{ id, name }]
      : [];
  })
  .sort((left, right) =>
    left.name.localeCompare(right.name, "en", {
      numeric: true,
      sensitivity: "base",
    }),
  );

const source = `// Generated from CCP EVE Online Static Data Export build ${buildNumber}.\n`
  + `// Source: https://developers.eveonline.com/static-data/\n`
  + `export const solarSystemCatalog: ReadonlyArray<{ id: number; name: string }> = ${JSON.stringify(systems)};\n`;

await writeFile(path.resolve(outputPath), source, "utf8");
console.log(`Generated ${systems.length} solar systems at ${outputPath}`);
