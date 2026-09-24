// Generates a compact bilingual inventory catalog from the official CCP SDE.
// Usage: node scripts/generate-buyback-catalog.mjs /path/to/sde.zip
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const zip = process.argv[2];
if (!zip) throw new Error("Pass the path to the official JSONL SDE archive");
const read = (name) => {
  const result = spawnSync("unzip", ["-p", zip, name], {
    encoding: "utf8",
    maxBuffer: 400 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Unable to read ${name}`);
  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};
const meta = read("_sde.jsonl").find((row) => row._key === "sde");
const categories = read("categories.jsonl")
  .map((row) => ({
    id: row._key,
    name: row.name?.zh || row.name?.en,
    nameEn: row.name?.en,
  }))
  .filter((row) => row.name);
const categoryIds = new Set(categories.map((row) => row.id));
const groups = new Map(
  read("groups.jsonl").map((row) => [row._key, row.categoryID]),
);
const types = read("types.jsonl")
  .flatMap((row) => {
    const categoryId = groups.get(row.groupID);
    if (!row.name?.en || !categoryIds.has(categoryId)) return [];
    return [
      {
        id: row._key,
        name: row.name.zh || row.name.en,
        nameEn: row.name.en,
        categoryId,
        marketGroupId: row.marketGroupID ?? null,
        published: row.published === true,
      },
    ];
  })
  .sort((a, b) => a.id - b.id);
const output = fileURLToPath(
  new URL(
    "../artifacts/api-server/src/data/eve-buyback-catalog.json",
    import.meta.url,
  ),
);
await writeFile(
  output,
  JSON.stringify({
    source: "https://developers.eveonline.com/static-data/",
    buildNumber: meta?.buildNumber,
    releaseDate: meta?.releaseDate,
    categories,
    types,
  }) + "\n",
);
console.log(
  JSON.stringify({
    output,
    buildNumber: meta?.buildNumber,
    types: types.length,
    categories: categories.length,
  }),
);
