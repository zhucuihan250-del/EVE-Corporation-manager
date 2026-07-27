import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

type LocalizedString = {
  en: string;
  zh: string;
};

type SdeType = {
  _key: number;
  groupID: number;
  name?: Partial<LocalizedString>;
  description?: Partial<LocalizedString>;
  published?: boolean;
  mass?: number;
  volume?: number;
  capacity?: number;
  marketGroupID?: number;
  metaGroupID?: number;
};

type SdeGroup = {
  _key: number;
  categoryID: number;
  name?: Partial<LocalizedString>;
  published?: boolean;
};

type SdeCategory = {
  _key: number;
  name?: Partial<LocalizedString>;
};

type SdeDogmaAttribute = {
  _key: number;
  name: string;
};

type SdeDogmaEffect = {
  _key: number;
  name: string;
};

type SdeTypeDogma = {
  _key: number;
  dogmaAttributes?: Array<{ attributeID: number; value: number }>;
  dogmaEffects?: Array<{ effectID: number; isDefault?: boolean }>;
};

type FittingSlot = "high" | "medium" | "low" | "rig" | "subsystem" | "charge" | "drone" | "other";

type FittingType = {
  id: number;
  categoryId: number;
  groupId: number;
  name: LocalizedString;
  groupName: LocalizedString;
  categoryName: LocalizedString;
  published: boolean;
  mass?: number;
  volume?: number;
  capacity?: number;
  marketGroupId?: number;
  metaGroupId?: number;
  slot: FittingSlot;
  hardpoint?: "turret" | "launcher";
  attributes: Record<string, number>;
  effects: string[];
};

const LATEST_SDE_URL = "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const workspaceDir = path.resolve(scriptDir, "../..");
const DEFAULT_OUTPUT = path.resolve(workspaceDir, "artifacts/api-server/src/data/eve-fitting-data.json");
const FITTING_CATEGORY_IDS = new Set([6, 7, 8, 18]);
const SELECTED_ATTRIBUTES = [
  "hiSlots",
  "medSlots",
  "lowSlots",
  "rigSlots",
  "maxSubSystems",
  "upgradeCapacity",
  "upgradeCost",
  "cpuOutput",
  "powerOutput",
  "cpu",
  "power",
  "shieldCapacity",
  "armorHP",
  "hp",
  "maxVelocity",
  "mass",
  "capacity",
  "capacitorCapacity",
  "capacitorRechargeTime",
  "signatureRadius",
  "scanResolution",
  "maxLockedTargets",
  "droneCapacity",
  "droneBandwidth",
  "turretSlotsLeft",
  "launcherSlotsLeft",
  "shieldEmDamageResonance",
  "shieldThermalDamageResonance",
  "shieldKineticDamageResonance",
  "shieldExplosiveDamageResonance",
  "armorEmDamageResonance",
  "armorThermalDamageResonance",
  "armorKineticDamageResonance",
  "armorExplosiveDamageResonance",
  "emDamageResonance",
  "thermalDamageResonance",
  "kineticDamageResonance",
  "explosiveDamageResonance",
  "capacitorNeed",
  "duration",
  "damageMultiplier",
  "emDamage",
  "thermalDamage",
  "kineticDamage",
  "explosiveDamage",
  "speedFactor",
  "maxVelocityBonus",
  "shieldCapacityBonus",
  "armorHPBonus",
  "structureHPMultiplier",
] as const;

function parseArgs(): { zipPath: string | null; outputPath: string; sourceUrl: string } {
  const args = process.argv.slice(2);
  let zipPath: string | null = null;
  let outputPath = DEFAULT_OUTPUT;
  let sourceUrl = LATEST_SDE_URL;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--zip") {
      zipPath = args[++i] ?? null;
    } else if (arg === "--output") {
      outputPath = path.resolve(args[++i] ?? outputPath);
    } else if (arg === "--url") {
      sourceUrl = args[++i] ?? sourceUrl;
    } else if (!arg.startsWith("--") && !zipPath) {
      zipPath = arg;
    }
  }

  return { zipPath, outputPath, sourceUrl };
}

function localized(value: Partial<LocalizedString> | undefined, fallback: string): LocalizedString {
  const en = value?.en?.trim() || fallback;
  return {
    en,
    zh: value?.zh?.trim() || en,
  };
}

function unzipFile(zipPath: string, filename: string): string {
  const result = spawnSync("unzip", ["-p", zipPath, filename], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Unable to read ${filename} from SDE zip: ${result.stderr}`);
  }

  return result.stdout;
}

function parseJsonl<T>(content: string): T[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

async function downloadSdeZip(sourceUrl: string): Promise<string> {
  const response = await fetch(sourceUrl, { redirect: "follow" });
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download SDE: HTTP ${response.status}`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "eve-sde-"));
  const zipPath = path.join(dir, "eve-online-static-data-jsonl.zip");
  await pipeline(Readable.fromWeb(response.body), createWriteStream(zipPath));
  return zipPath;
}

function slotFromEffects(categoryId: number, effects: string[]): FittingSlot {
  if (categoryId === 8) return "charge";
  if (categoryId === 18) return "drone";
  if (effects.includes("hiPower")) return "high";
  if (effects.includes("medPower")) return "medium";
  if (effects.includes("loPower")) return "low";
  if (effects.includes("rigSlot")) return "rig";
  if (effects.includes("subSystem")) return "subsystem";
  return "other";
}

function hardpointFromEffects(effects: string[]): "turret" | "launcher" | undefined {
  if (effects.includes("turretFitted")) return "turret";
  if (effects.includes("launcherFitted")) return "launcher";
  return undefined;
}

async function main(): Promise<void> {
  const { zipPath: inputZipPath, outputPath, sourceUrl } = parseArgs();
  const zipPath = inputZipPath ?? await downloadSdeZip(sourceUrl);

  if (!existsSync(zipPath)) {
    throw new Error(`SDE zip not found: ${zipPath}`);
  }

  const meta = parseJsonl<{ _key: string; buildNumber?: number; releaseDate?: string }>(unzipFile(zipPath, "_sde.jsonl"));
  const build = meta.find((entry) => entry._key === "sde");
  const categories = new Map(parseJsonl<SdeCategory>(unzipFile(zipPath, "categories.jsonl")).map((entry) => [entry._key, entry]));
  const groups = new Map(parseJsonl<SdeGroup>(unzipFile(zipPath, "groups.jsonl")).map((entry) => [entry._key, entry]));
  const attributeIdByName = new Map(
    parseJsonl<SdeDogmaAttribute>(unzipFile(zipPath, "dogmaAttributes.jsonl"))
      .map((entry) => [entry.name, entry._key] as const),
  );
  const attributeNameById = new Map([...attributeIdByName.entries()].map(([name, id]) => [id, name] as const));
  const selectedAttributeIds = new Set(SELECTED_ATTRIBUTES.map((name) => attributeIdByName.get(name)).filter((id): id is number => typeof id === "number"));
  const effectNameById = new Map(
    parseJsonl<SdeDogmaEffect>(unzipFile(zipPath, "dogmaEffects.jsonl"))
      .map((entry) => [entry._key, entry.name] as const),
  );
  const dogmaByTypeId = new Map(parseJsonl<SdeTypeDogma>(unzipFile(zipPath, "typeDogma.jsonl")).map((entry) => [entry._key, entry]));
  const fittingTypes: FittingType[] = [];

  for (const type of parseJsonl<SdeType>(unzipFile(zipPath, "types.jsonl"))) {
    const group = groups.get(type.groupID);
    if (!group || !FITTING_CATEGORY_IDS.has(group.categoryID)) continue;
    if (type.published === false) continue;

    const category = categories.get(group.categoryID);
    const dogma = dogmaByTypeId.get(type._key);
    const effects = (dogma?.dogmaEffects ?? [])
      .map((effect) => effectNameById.get(effect.effectID))
      .filter((effect): effect is string => Boolean(effect));
    const attributes: Record<string, number> = {};

    for (const attribute of dogma?.dogmaAttributes ?? []) {
      if (!selectedAttributeIds.has(attribute.attributeID)) continue;
      const name = attributeNameById.get(attribute.attributeID);
      if (name) attributes[name] = attribute.value;
    }

    const hardpoint = hardpointFromEffects(effects);
    fittingTypes.push({
      id: type._key,
      categoryId: group.categoryID,
      groupId: type.groupID,
      name: localized(type.name, `Type ${type._key}`),
      groupName: localized(group.name, `Group ${type.groupID}`),
      categoryName: localized(category?.name, `Category ${group.categoryID}`),
      published: true,
      ...(type.mass !== undefined ? { mass: type.mass } : {}),
      ...(type.volume !== undefined ? { volume: type.volume } : {}),
      ...(type.capacity !== undefined ? { capacity: type.capacity } : {}),
      ...(type.marketGroupID !== undefined ? { marketGroupId: type.marketGroupID } : {}),
      ...(type.metaGroupID !== undefined ? { metaGroupId: type.metaGroupID } : {}),
      slot: slotFromEffects(group.categoryID, effects),
      ...(hardpoint ? { hardpoint } : {}),
      attributes,
      effects,
    });
  }

  fittingTypes.sort((a, b) => a.name.en.localeCompare(b.name.en));

  const output = {
    buildNumber: build?.buildNumber ?? null,
    releaseDate: build?.releaseDate ?? null,
    generatedAt: new Date().toISOString(),
    source: inputZipPath ? path.basename(inputZipPath) : sourceUrl,
    attributeIds: Object.fromEntries(
      SELECTED_ATTRIBUTES.map((name) => [name, attributeIdByName.get(name) ?? null]),
    ),
    counts: {
      ships: fittingTypes.filter((type) => type.categoryId === 6).length,
      modules: fittingTypes.filter((type) => type.categoryId === 7).length,
      charges: fittingTypes.filter((type) => type.categoryId === 8).length,
      drones: fittingTypes.filter((type) => type.categoryId === 18).length,
    },
    types: fittingTypes,
  };

  await mkdirSync(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(output)}\n`, "utf8");

  const stats = JSON.parse(await readFile(outputPath, "utf8")) as typeof output;
  console.log(`Wrote ${stats.types.length} fitting types to ${outputPath}`);
  console.log(`SDE build ${stats.buildNumber ?? "unknown"}: ${JSON.stringify(stats.counts)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
