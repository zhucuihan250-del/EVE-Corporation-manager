import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type FittingLanguage = "en" | "zh";
export type FittingCategory = "ship" | "module" | "charge" | "drone";
export type FittingSlot = "high" | "medium" | "low" | "rig" | "subsystem" | "charge" | "drone" | "other";
export type FittingMode = "pvp" | "pve";

type LocalizedString = {
  en: string;
  zh: string;
};

export type FittingType = {
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

type FittingDataFile = {
  buildNumber: number | null;
  releaseDate: string | null;
  generatedAt: string;
  source: string;
  counts: {
    ships: number;
    modules: number;
    charges: number;
    drones: number;
  };
  types: FittingType[];
};

type CatalogItem = {
  typeId: number;
  category: FittingCategory;
  groupId: number;
  slot: FittingSlot;
  hardpoint: "turret" | "launcher" | null;
  name: string;
  nameEn: string;
  nameZh: string;
  groupName: string;
  categoryName: string;
};

type SlotMetric = {
  used: number;
  limit: number;
  overloaded: boolean;
};

type ResourceMetric = {
  used: number;
  limit: number;
  percent: number;
  overloaded: boolean;
};

type SimulatedModule = CatalogItem & {
  quantity: number;
  cpu: number;
  powergrid: number;
};

type SimulationInput = {
  shipId: number;
  modules: Array<{ typeId: number; quantity?: number }>;
  mode: FittingMode;
  language: FittingLanguage;
};

type SimulationResult = {
  precision: "approximate";
  sdeBuildNumber: number | null;
  ship: CatalogItem;
  modules: SimulatedModule[];
  slots: Record<"high" | "medium" | "low" | "rig" | "subsystem", SlotMetric>;
  resources: {
    cpu: ResourceMetric;
    powergrid: ResourceMetric;
    calibration: ResourceMetric;
  };
  hardpoints: {
    turret: SlotMetric;
    launcher: SlotMetric;
  };
  defense: {
    shieldHp: number;
    armorHp: number;
    hullHp: number;
    estimatedEhp: number;
  };
  mobility: {
    maxVelocity: number;
    mass: number;
    signatureRadius: number;
  };
  capacitor: {
    capacity: number;
    rechargeTime: number | null;
    activeCapUsePerSecond: number;
  };
  offense: {
    weaponCount: number;
    estimatedDps: number | null;
  };
  recommendations: string[];
  limitations: string[];
};

const CATEGORY_BY_ID: Record<number, FittingCategory> = {
  6: "ship",
  7: "module",
  8: "charge",
  18: "drone",
};

const slotKeys = ["high", "medium", "low", "rig", "subsystem"] as const;

let cachedData: FittingDataFile | null = null;
let cachedTypeById: Map<number, FittingType> | null = null;

function fittingDataPath(): string {
  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(serverDir, "../data/eve-fitting-data.json"),
    path.resolve(serverDir, "../src/data/eve-fitting-data.json"),
    path.resolve(process.cwd(), "src/data/eve-fitting-data.json"),
    path.resolve(process.cwd(), "artifacts/api-server/src/data/eve-fitting-data.json"),
  ];

  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`EVE fitting data file not found. Checked: ${candidates.join(", ")}`);
  }

  return found;
}

export function getFittingData(): FittingDataFile {
  if (cachedData) return cachedData;

  cachedData = JSON.parse(readFileSync(fittingDataPath(), "utf8")) as FittingDataFile;
  cachedTypeById = new Map(cachedData.types.map((type) => [type.id, type]));
  return cachedData;
}

export function getFittingType(typeId: number): FittingType | null {
  getFittingData();
  return cachedTypeById?.get(typeId) ?? null;
}

function text(value: LocalizedString, language: FittingLanguage): string {
  return language === "zh" ? value.zh : value.en;
}

function categoryOf(type: FittingType): FittingCategory {
  return CATEGORY_BY_ID[type.categoryId] ?? "module";
}

function toCatalogItem(type: FittingType, language: FittingLanguage): CatalogItem {
  return {
    typeId: type.id,
    category: categoryOf(type),
    groupId: type.groupId,
    slot: type.slot,
    hardpoint: type.hardpoint ?? null,
    name: text(type.name, language),
    nameEn: type.name.en,
    nameZh: type.name.zh,
    groupName: text(type.groupName, language),
    categoryName: text(type.categoryName, language),
  };
}

function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function searchFittingCatalog(options: {
  query?: string;
  category?: FittingCategory | "all";
  slot?: FittingSlot | "all";
  language: FittingLanguage;
  limit?: number;
}): { sdeBuildNumber: number | null; generatedAt: string; items: CatalogItem[] } {
  const data = getFittingData();
  const query = normalizeSearch(options.query ?? "");
  const limit = Math.max(1, Math.min(options.limit ?? 50, 100));
  const category = options.category ?? "all";
  const slot = options.slot ?? "all";

  const scored: Array<{ score: number; type: FittingType }> = [];
  for (const type of data.types) {
    const typeCategory = categoryOf(type);
    if (category !== "all" && typeCategory !== category) continue;
    if (slot !== "all" && type.slot !== slot) continue;

    let score = 1;
    if (query) {
      const name = normalizeSearch(text(type.name, options.language));
      const nameEn = normalizeSearch(type.name.en);
      const nameZh = normalizeSearch(type.name.zh);
      const groupName = normalizeSearch(text(type.groupName, options.language));
      const haystacks = [name, nameEn, nameZh, groupName];
      if (!haystacks.some((candidate) => candidate.includes(query))) continue;
      score =
        name === query || nameEn === query || nameZh === query
          ? 100
          : name.startsWith(query) || nameEn.startsWith(query) || nameZh.startsWith(query)
            ? 50
            : groupName.includes(query)
              ? 10
              : 20;
    }

    scored.push({ score, type });
  }

  scored.sort((a, b) => b.score - a.score || text(a.type.name, options.language).localeCompare(text(b.type.name, options.language)));

  return {
    sdeBuildNumber: data.buildNumber,
    generatedAt: data.generatedAt,
    items: scored.slice(0, limit).map(({ type }) => toCatalogItem(type, options.language)),
  };
}

function attr(type: FittingType, name: string): number {
  return type.attributes[name] ?? 0;
}

function rounded(value: number, precision = 2): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

function resourceMetric(used: number, limit: number): ResourceMetric {
  return {
    used: rounded(used),
    limit: rounded(limit),
    percent: limit > 0 ? rounded((used / limit) * 100, 1) : 0,
    overloaded: limit > 0 && used > limit,
  };
}

function slotMetric(used: number, limit: number): SlotMetric {
  return {
    used,
    limit,
    overloaded: used > limit,
  };
}

function averageResonance(type: FittingType, prefix: "shield" | "armor" | "hull"): number {
  const names = prefix === "shield"
    ? ["shieldEmDamageResonance", "shieldThermalDamageResonance", "shieldKineticDamageResonance", "shieldExplosiveDamageResonance"]
    : prefix === "armor"
      ? ["armorEmDamageResonance", "armorThermalDamageResonance", "armorKineticDamageResonance", "armorExplosiveDamageResonance"]
      : ["emDamageResonance", "thermalDamageResonance", "kineticDamageResonance", "explosiveDamageResonance"];
  const values = names.map((name) => attr(type, name)).filter((value) => value > 0);
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 1;
}

function typeText(type: FittingType): string {
  return `${type.name.en} ${type.name.zh} ${type.groupName.en} ${type.groupName.zh} ${type.effects.join(" ")}`.toLocaleLowerCase();
}

function hasAny(types: FittingType[], patterns: RegExp[]): boolean {
  return types.some((type) => patterns.some((pattern) => pattern.test(typeText(type))));
}

const copy = {
  zh: {
    resourceOver: (name: string) => `${name} 已超出上限，当前装配无法上线。`,
    slotOver: (name: string) => `${name} 槽位超出上限，需要减少同槽装备。`,
    turretOver: "炮台挂点超出上限，需要减少炮台类武器。",
    launcherOver: "发射器挂点超出上限，需要减少导弹发射器。",
    pyfaLimit: "当前版本不计算技能、植入、舰船加成、弹药、无人机、过热和完整 dogma 叠乘，数值为近似检查。",
    noWeapon: "没有检测到主要武器或无人机系统；PVP/PVE 都会缺少实际输出压力。",
    noPropPvp: "PVP 装配通常需要推进装备（加力燃烧器或微型跃迁推进器）来控制距离。",
    noTacklePvp: "PVP 装配缺少跃迁扰断/扰频或网子，单人/小队抓人能力有限。",
    noBufferPvp: "PVP 装配没有明显的护盾/装甲缓冲或抗性模块，容易被集火快速击穿。",
    capHighPvp: "主动装备耗电较高，PVP 中可能被毁电或长时间交战拖垮。",
    noTankPve: "PVE 装配缺少明显的主动维修或抗性模块，持续承伤能力有限。",
    noCapPve: "PVE 装配没有明显电容补强，长时间刷怪可能断电。",
    pveDamage: "PVE 建议根据目标 NPC 抗性选择弹药/伤害类型，并补充应用模块提升命中。",
    shipRole: (ship: string, group: string) => `${ship} 属于 ${group}，建议优先围绕船体槽位和加成方向配装。`,
    goodResources: "CPU、能量栅格和槽位检查通过，可以继续细化抗性、弹药和电容稳定性。",
  },
  en: {
    resourceOver: (name: string) => `${name} is over limit; this fit cannot be fully online.`,
    slotOver: (name: string) => `${name} slots are over limit; remove modules from that rack.`,
    turretOver: "Turret hardpoints are over limit; remove turret weapons.",
    launcherOver: "Launcher hardpoints are over limit; remove missile launchers.",
    pyfaLimit: "This version does not calculate skills, implants, hull bonuses, ammunition, drones, overheating, or full dogma stacking; numbers are approximate checks.",
    noWeapon: "No primary weapon or drone system detected; both PVP and PVE pressure will be limited.",
    noPropPvp: "PVP fits usually need propulsion, such as an afterburner or microwarpdrive, to control range.",
    noTacklePvp: "PVP fit lacks point/scram or web support, limiting solo and small-gang catch potential.",
    noBufferPvp: "PVP fit has no obvious buffer or resist module and may fold quickly under focus fire.",
    capHighPvp: "Active capacitor demand is high; neutralizers or long fights may break the fit.",
    noTankPve: "PVE fit lacks obvious active repair or resistance modules, limiting sustained tank.",
    noCapPve: "PVE fit lacks obvious capacitor support; long sites may cap out.",
    pveDamage: "For PVE, match ammunition and damage type to NPC resist holes and add application modules where needed.",
    shipRole: (ship: string, group: string) => `${ship} is a ${group}; build around its slot layout and hull bonus direction.`,
    goodResources: "CPU, powergrid, and slot checks pass; continue refining resist profile, ammunition, and capacitor stability.",
  },
};

export function simulateFitting(input: SimulationInput): SimulationResult {
  const data = getFittingData();
  const language = input.language;
  const labels = copy[language];
  const ship = getFittingType(input.shipId);

  if (!ship || categoryOf(ship) !== "ship") {
    throw new Error("Ship not found");
  }

  const expandedModules: FittingType[] = [];
  const simulatedModules: SimulatedModule[] = [];
  for (const moduleInput of input.modules) {
    const module = getFittingType(moduleInput.typeId);
    if (!module) continue;
    const quantity = Math.max(1, Math.min(Math.floor(moduleInput.quantity ?? 1), 99));
    for (let index = 0; index < quantity; index++) expandedModules.push(module);
    simulatedModules.push({
      ...toCatalogItem(module, language),
      quantity,
      cpu: rounded(attr(module, "cpu") * quantity),
      powergrid: rounded(attr(module, "power") * quantity),
    });
  }

  const usedSlots = Object.fromEntries(slotKeys.map((slot) => [slot, expandedModules.filter((module) => module.slot === slot).length])) as Record<typeof slotKeys[number], number>;
  const slots = {
    high: slotMetric(usedSlots.high, attr(ship, "hiSlots")),
    medium: slotMetric(usedSlots.medium, attr(ship, "medSlots")),
    low: slotMetric(usedSlots.low, attr(ship, "lowSlots")),
    rig: slotMetric(usedSlots.rig, attr(ship, "rigSlots")),
    subsystem: slotMetric(usedSlots.subsystem, attr(ship, "maxSubSystems")),
  };

  const cpuUsed = expandedModules.reduce((sum, module) => sum + attr(module, "cpu"), 0);
  const powerUsed = expandedModules.reduce((sum, module) => sum + attr(module, "power"), 0);
  const calibrationUsed = expandedModules.reduce((sum, module) => sum + attr(module, "upgradeCost"), 0);
  const turretUsed = expandedModules.filter((module) => module.hardpoint === "turret").length;
  const launcherUsed = expandedModules.filter((module) => module.hardpoint === "launcher").length;
  const droneUsed = expandedModules.filter((module) => categoryOf(module) === "drone").length;
  const capUsePerSecond = expandedModules.reduce((sum, module) => {
    const duration = attr(module, "duration");
    const capNeed = attr(module, "capacitorNeed");
    return duration > 0 ? sum + capNeed / (duration / 1000) : sum;
  }, 0);
  const estimatedDps = expandedModules.reduce((sum, module) => {
    const duration = attr(module, "duration");
    const damage = attr(module, "emDamage") + attr(module, "thermalDamage") + attr(module, "kineticDamage") + attr(module, "explosiveDamage");
    const multiplier = attr(module, "damageMultiplier") || 1;
    return duration > 0 && damage > 0 ? sum + (damage * multiplier) / (duration / 1000) : sum;
  }, 0);
  const shieldHp = attr(ship, "shieldCapacity");
  const armorHp = attr(ship, "armorHP");
  const hullHp = attr(ship, "hp");
  const estimatedEhp =
    shieldHp / averageResonance(ship, "shield") +
    armorHp / averageResonance(ship, "armor") +
    hullHp / averageResonance(ship, "hull");

  const resources = {
    cpu: resourceMetric(cpuUsed, attr(ship, "cpuOutput")),
    powergrid: resourceMetric(powerUsed, attr(ship, "powerOutput")),
    calibration: resourceMetric(calibrationUsed, attr(ship, "upgradeCapacity")),
  };
  const hardpoints = {
    turret: slotMetric(turretUsed, attr(ship, "turretSlotsLeft")),
    launcher: slotMetric(launcherUsed, attr(ship, "launcherSlotsLeft")),
  };

  const recommendations = [
    labels.shipRole(text(ship.name, language), text(ship.groupName, language)),
  ];
  const limitations = [labels.pyfaLimit];

  for (const [name, metric] of Object.entries(resources)) {
    if (metric.overloaded) limitations.push(labels.resourceOver(name.toUpperCase()));
  }
  for (const [name, metric] of Object.entries(slots)) {
    if (metric.overloaded) limitations.push(labels.slotOver(name.toUpperCase()));
  }
  if (hardpoints.turret.overloaded) limitations.push(labels.turretOver);
  if (hardpoints.launcher.overloaded) limitations.push(labels.launcherOver);

  const hasWeapon = droneUsed > 0 || hasAny(expandedModules, [/weapon/, /turret/, /launcher/, /missile/, /disintegrator/, /drone/, /炮台/, /发射器/, /导弹/, /无人机/]);
  const hasProp = hasAny(expandedModules, [/afterburner/, /microwarpdrive/, /propulsion/, /加力/, /跃迁推进/]);
  const hasTackle = hasAny(expandedModules, [/warp disrupt/, /warp scram/, /stasis web/, /跃迁扰/, /停滞缠绕/]);
  const hasTank = hasAny(expandedModules, [/shield extender/, /shield booster/, /armor repair/, /armor plate/, /hardener/, /resistance/, /damage control/, /护盾/, /装甲/, /抗性/, /损伤控制/]);
  const hasCap = hasAny(expandedModules, [/capacitor/, /cap battery/, /cap booster/, /recharger/, /电容/]);

  if (!hasWeapon) limitations.push(labels.noWeapon);
  if (input.mode === "pvp") {
    if (!hasProp) recommendations.push(labels.noPropPvp);
    if (!hasTackle) recommendations.push(labels.noTacklePvp);
    if (!hasTank) recommendations.push(labels.noBufferPvp);
    if (capUsePerSecond > attr(ship, "capacitorCapacity") / 60) limitations.push(labels.capHighPvp);
  } else {
    if (!hasTank) recommendations.push(labels.noTankPve);
    if (!hasCap && capUsePerSecond > 3) recommendations.push(labels.noCapPve);
    recommendations.push(labels.pveDamage);
  }
  if (!Object.values(resources).some((metric) => metric.overloaded) && !Object.values(slots).some((metric) => metric.overloaded)) {
    recommendations.push(labels.goodResources);
  }

  return {
    precision: "approximate",
    sdeBuildNumber: data.buildNumber,
    ship: toCatalogItem(ship, language),
    modules: simulatedModules,
    slots,
    resources,
    hardpoints,
    defense: {
      shieldHp: rounded(shieldHp),
      armorHp: rounded(armorHp),
      hullHp: rounded(hullHp),
      estimatedEhp: rounded(estimatedEhp),
    },
    mobility: {
      maxVelocity: rounded(attr(ship, "maxVelocity")),
      mass: rounded(ship.mass ?? attr(ship, "mass")),
      signatureRadius: rounded(attr(ship, "signatureRadius")),
    },
    capacitor: {
      capacity: rounded(attr(ship, "capacitorCapacity")),
      rechargeTime: attr(ship, "capacitorRechargeTime") || null,
      activeCapUsePerSecond: rounded(capUsePerSecond),
    },
    offense: {
      weaponCount: turretUsed + launcherUsed + droneUsed,
      estimatedDps: estimatedDps > 0 ? rounded(estimatedDps) : null,
    },
    recommendations,
    limitations: [...new Set(limitations)],
  };
}
