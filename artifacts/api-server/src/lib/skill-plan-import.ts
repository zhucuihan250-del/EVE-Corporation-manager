import type { RequiredSkill } from "@workspace/db";

const ESI_BASE = "https://esi.evetech.net/latest";
const ESI_COMPATIBILITY_DATE = "2026-07-20";
const USER_AGENT = process.env.EVE_ESI_USER_AGENT
  || `EVE-PAP-Tracker/1.0 (+${process.env.FRONTEND_URL || "https://zephyr-fleet-track-production.up.railway.app"})`;

type PendingSkill = {
  lookupName: string;
  displayName: string;
  level: number;
  line: string;
};

type ParsedLine =
  | { kind: "skill"; skill: PendingSkill; format: SkillPlanImportFormat }
  | { kind: "resolved"; skill: RequiredSkill; format: SkillPlanImportFormat }
  | { kind: "unresolved"; line: string };

type UniverseIdsResponse = {
  inventory_types?: Array<{ id: number; name: string }>;
};

export type SkillPlanImportFormat = "eve_localized" | "legacy_csv" | "plain" | "mixed";

export type SkillPlanImportResult = {
  requiredSkills: RequiredSkill[];
  unresolvedLines: string[];
  sourceFormat: SkillPlanImportFormat;
  parsedLineCount: number;
};

export class SkillPlanImportError extends Error {
  readonly code: "INVALID_TEXT" | "ESI_UNAVAILABLE";

  constructor(
    message: string,
    code: "INVALID_TEXT" | "ESI_UNAVAILABLE",
  ) {
    super(message);
    this.code = code;
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-f]+|amp|quot|apos|lt|gt);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();
    if (normalized === "amp") return "&";
    if (normalized === "quot") return '"';
    if (normalized === "apos") return "'";
    if (normalized === "lt") return "<";
    if (normalized === "gt") return ">";
    const radix = normalized.startsWith("#x") ? 16 : 10;
    const rawCodePoint = normalized.replace(/^#x?/, "");
    const codePoint = Number.parseInt(rawCodePoint, radix);
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  });
}

function parseLevel(value: string): number | null {
  const normalized = value.trim().toUpperCase();
  const romanLevels: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4, V: 5 };
  const level = romanLevels[normalized] ?? Number(normalized);
  return Number.isInteger(level) && level >= 1 && level <= 5 ? level : null;
}

function cleanDisplayName(value: string): string {
  return decodeEntities(value)
    .replace(/<[^>]+>/g, "")
    .replace(/\*+\s*$/, "")
    .trim();
}

function parseLine(line: string): ParsedLine {
  const localized = line.match(
    /^<localized\s+hint\s*=\s*(?:"([^"]+)"|'([^']+)')\s*>(.*?)<\/localized>\s+([1-5]|I{1,3}|IV|V)\s*$/i,
  );
  if (localized) {
    const lookupName = decodeEntities(localized[1] ?? localized[2] ?? "").trim();
    const displayName = cleanDisplayName(localized[3] ?? "") || lookupName;
    const level = parseLevel(localized[4] ?? "");
    if (lookupName && displayName && level) {
      return {
        kind: "skill",
        format: "eve_localized",
        skill: { lookupName, displayName, level, line },
      };
    }
  }

  const legacy = line.match(/^(\d+)\s*,\s*(.+?)\s*,\s*([1-5])\s*$/);
  if (legacy) {
    const skillId = Number(legacy[1]);
    const name = cleanDisplayName(legacy[2] ?? "");
    const level = parseLevel(legacy[3] ?? "");
    if (Number.isInteger(skillId) && skillId > 0 && name && level) {
      return { kind: "resolved", format: "legacy_csv", skill: { skillId, name, level } };
    }
  }

  const plain = line.match(/^(.+?)(?:\s+|\s*,\s*)([1-5]|I{1,3}|IV|V)\s*$/i);
  if (plain) {
    const lookupName = cleanDisplayName(plain[1] ?? "");
    const level = parseLevel(plain[2] ?? "");
    if (lookupName && level) {
      return {
        kind: "skill",
        format: "plain",
        skill: { lookupName, displayName: lookupName, level, line },
      };
    }
  }

  return { kind: "unresolved", line };
}

async function fetchInventoryTypes(
  names: string[],
  language: "en" | "zh",
): Promise<Array<{ id: number; name: string }>> {
  if (names.length === 0) return [];
  let response: globalThis.Response;
  try {
    response = await fetch(
      `${ESI_BASE}/universe/ids/?datasource=tranquility&language=${language}`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
          "X-Compatibility-Date": ESI_COMPATIBILITY_DATE,
        },
        body: JSON.stringify(names),
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    throw new SkillPlanImportError("EVE skill-name lookup is temporarily unavailable", "ESI_UNAVAILABLE");
  }
  if (!response.ok) {
    throw new SkillPlanImportError("EVE skill-name lookup is temporarily unavailable", "ESI_UNAVAILABLE");
  }
  const payload = (await response.json()) as UniverseIdsResponse;
  return payload.inventory_types ?? [];
}

async function resolveInventoryTypes(names: string[]): Promise<Map<string, { id: number; name: string }>> {
  const result = new Map<string, { id: number; name: string }>();
  const englishTypes = await fetchInventoryTypes(names, "en");
  for (const type of englishTypes) result.set(type.name.toLocaleLowerCase("en"), type);

  const unresolvedNames = names.filter((name) => !result.has(name.toLocaleLowerCase("en")));
  const chineseTypes = await fetchInventoryTypes(unresolvedNames, "zh");
  for (const type of chineseTypes) result.set(type.name.toLocaleLowerCase("zh"), type);
  return result;
}

export async function importSkillPlanText(text: string): Promise<SkillPlanImportResult> {
  if (typeof text !== "string" || text.length > 100_000) {
    throw new SkillPlanImportError("Skill plan text is too large", "INVALID_TEXT");
  }
  const lines = text
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 2_000) {
    throw new SkillPlanImportError("Skill plan has too many lines", "INVALID_TEXT");
  }

  const parsed = lines.map(parseLine);
  const formats = new Set(parsed.filter((item) => item.kind !== "unresolved").map((item) => item.format));
  const pendingByName = new Map<string, PendingSkill>();
  const resolvedById = new Map<number, RequiredSkill>();
  const unresolvedLines = parsed
    .filter((item): item is Extract<ParsedLine, { kind: "unresolved" }> => item.kind === "unresolved")
    .map((item) => item.line);

  for (const item of parsed) {
    if (item.kind === "resolved") {
      const existing = resolvedById.get(item.skill.skillId);
      if (!existing || item.skill.level > existing.level) resolvedById.set(item.skill.skillId, item.skill);
      continue;
    }
    if (item.kind !== "skill") continue;
    const key = item.skill.lookupName.toLocaleLowerCase("en");
    const existing = pendingByName.get(key);
    if (!existing || item.skill.level > existing.level) pendingByName.set(key, item.skill);
  }

  if (pendingByName.size + resolvedById.size > 100) {
    throw new SkillPlanImportError("Skill plan cannot contain more than 100 unique skills", "INVALID_TEXT");
  }

  const inventoryTypes = await resolveInventoryTypes([...pendingByName.values()].map((skill) => skill.lookupName));
  for (const [key, skill] of pendingByName) {
    const type = inventoryTypes.get(key);
    if (!type) {
      unresolvedLines.push(skill.line);
      continue;
    }
    const resolved: RequiredSkill = { skillId: type.id, name: skill.displayName, level: skill.level };
    const existing = resolvedById.get(resolved.skillId);
    if (!existing || resolved.level > existing.level) resolvedById.set(resolved.skillId, resolved);
  }

  const requiredSkills = [...resolvedById.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  const sourceFormat: SkillPlanImportFormat = formats.size > 1
    ? "mixed"
    : (formats.values().next().value as SkillPlanImportFormat | undefined) ?? "plain";
  return {
    requiredSkills,
    unresolvedLines,
    sourceFormat,
    parsedLineCount: parsed.length - unresolvedLines.length,
  };
}
