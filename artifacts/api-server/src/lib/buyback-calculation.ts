export const PRICE_BASES = ["buy", "sell", "mid", "fixed"] as const;
export type BuybackPriceBasis = (typeof PRICE_BASES)[number];
export type BuybackSettings = {
  enabled: boolean;
  defaultEnabled: boolean;
  priceBasis: BuybackPriceBasis;
  ratePercent: number;
  fixedPrice: string | null;
  quoteValidityMinutes: number;
  version: number;
};
export type BuybackRule = {
  id?: number;
  scope: "category" | "type";
  targetId: number;
  targetName?: string;
  enabled: boolean | null;
  priceBasis: BuybackPriceBasis | null;
  ratePercent: number | null;
  fixedPrice: string | null;
};
export type BuybackType = { typeId: number; name: string; categoryId: number; categoryName: string };
export type BuybackMarketPrice = { buy: string | null; sell: string | null; updatedAt: string; error?: string };
export type BuybackInput = { inputName: string; quantity: number; error: string | null };
export type BuybackQuoteLine = {
  inputName: string;
  typeId: number | null;
  name: string;
  quantity: number;
  status: "accepted" | "excluded" | "unrecognized" | "unpriced" | "invalid";
  reason: string | null;
  priceBasis: BuybackPriceBasis | null;
  referencePrice: string | null;
  ratePercent: number | null;
  unitPrice: string | null;
  totalIsk: string | null;
  marketUpdatedAt: string | null;
};

export const DEFAULT_BUYBACK_SETTINGS: Readonly<BuybackSettings> = {
  enabled: false,
  defaultEnabled: true,
  priceBasis: "buy",
  ratePercent: 100,
  fixedPrice: null,
  quoteValidityMinutes: 30,
  version: 0,
};

export class BuybackError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

function isBasis(value: unknown): value is BuybackPriceBasis {
  return PRICE_BASES.includes(value as BuybackPriceBasis);
}

function validRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0.01 && value <= 1000
    && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
}

function validFixedPrice(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{1,16}(\.\d{1,2})?$/.test(value)) return false;
  const amount = decimalUnits(value, 2);
  return amount !== null && amount > 0n && amount <= 100_000_000_000_000_000n;
}

export function validateBuybackSettings(input: unknown): Omit<BuybackSettings, "version"> & { version: number } {
  const value = input as Partial<BuybackSettings> | null;
  if (!value || typeof value.enabled !== "boolean" || typeof value.defaultEnabled !== "boolean"
    || !isBasis(value.priceBasis) || !validRate(value.ratePercent)
    || !(value.fixedPrice === null || validFixedPrice(value.fixedPrice))
    || (value.priceBasis === "fixed" && !validFixedPrice(value.fixedPrice))
    || !Number.isInteger(value.quoteValidityMinutes) || value.quoteValidityMinutes! < 1 || value.quoteValidityMinutes! > 1440
    || !Number.isSafeInteger(value.version) || value.version! < 0 || value.version! >= 2_147_483_647) {
    throw new BuybackError(400, "INVALID_BUYBACK_SETTINGS", "回收设置无效：比例为 0.01–1000%，最多两位小数；固定价必须大于零；有效期为 1–1440 分钟。");
  }
  return {
    enabled: value.enabled, defaultEnabled: value.defaultEnabled, priceBasis: value.priceBasis,
    ratePercent: value.ratePercent, fixedPrice: value.fixedPrice, quoteValidityMinutes: value.quoteValidityMinutes!, version: value.version!,
  };
}

export function validateBuybackRule(input: unknown): BuybackRule {
  const value = input as Partial<BuybackRule> | null;
  if (!value || !["category", "type"].includes(value.scope!) || !Number.isSafeInteger(value.targetId) || value.targetId! <= 0
    || !(value.enabled === null || typeof value.enabled === "boolean")
    || !(value.priceBasis === null || isBasis(value.priceBasis))
    || !(value.ratePercent === null || validRate(value.ratePercent))
    || !(value.fixedPrice === null || validFixedPrice(value.fixedPrice))) {
    throw new BuybackError(400, "INVALID_BUYBACK_RULE", "回收规则无效，请检查对象、比例和固定单价。");
  }
  return { scope: value.scope!, targetId: value.targetId!, enabled: value.enabled!, priceBasis: value.priceBasis!, ratePercent: value.ratePercent!, fixedPrice: value.fixedPrice! };
}

/** Parse integer quantities conservatively: never turn a malformed decimal into a different quantity. */
function quantityFromText(text: string): number | null {
  const cleaned = text.trim().replace(/[\u00a0\u202f]/g, " ");
  if (!/^\d+$/.test(cleaned) && !/^\d{1,3}(,\d{3})+$/.test(cleaned) && !/^\d{1,3}( \d{3})+$/.test(cleaned)) return null;
  const quantity = Number(cleaned.replace(/[, ]/g, ""));
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : null;
}

export function parseBuybackClipboard(text: unknown): BuybackInput[] {
  if (typeof text !== "string" || text.length > 100_000) throw new BuybackError(400, "INVALID_BUYBACK_TEXT", "请粘贴不超过 100,000 字符的物品清单。");
  // Preserve tabs: a present but empty quantity column is invalid, not "1".
  const rows = text.split(/\r?\n/).filter((row) => row.trim().length > 0);
  if (rows.length === 0 || rows.length > 200) throw new BuybackError(400, "BUYBACK_LINE_LIMIT", "每次报价需要 1–200 行物品。");
  return rows.map((row) => {
    const columns = row.split("\t");
    let name = columns[0]!.trim();
    let quantity: number | null = 1;
    if (columns.length > 1) quantity = quantityFromText(columns[1]!);
    else {
      // A trailing number can be part of a real type name (e.g. Cap Booster 800).
      // Without tab-separated columns, only an explicit multiplication marker
      // identifies a quantity; never guess and change a legitimate item name.
      const match = row.trim().match(/^(.*?)\s[x×]\s*(\d[\d, ]*)$/i);
      if (match) { name = match[1]!.trim(); quantity = quantityFromText(match[2]!); }
    }
    // Abyssal filaments and mutaplasmids are ordinary market commodities.
    // Only explicit non-standard/copy markers are excluded here; all blueprint
    // types are additionally guarded after catalog resolution below.
    const special = /(?:\bblueprint copy\b|蓝图副本|(?:\(|（)(?:mutated|突变属性)(?:\)|）))/i.test(row);
    const error = special ? "含副本或非标准属性标记，请交由管理员单独估价。"
      : !name || name.length > 250 ? "物品名称为空或过长。"
        : quantity === null ? "数量必须为正整数；游戏清单请保留名称和数量列。" : null;
    return { inputName: name, quantity: quantity ?? 0, error };
  });
}

/** Fixed-point decimal parsing, without converting ISK values through floating point. */
export function decimalUnits(value: string, places: number): bigint | null {
  if (!/^\d{1,20}(\.\d{1,10})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > places && /[1-9]/.test(fraction.slice(places))) return null;
  return BigInt(whole!) * 10n ** BigInt(places) + BigInt(fraction.slice(0, places).padEnd(places, "0") || "0");
}

export function formatUnits(value: bigint, places: number, trim = false): string {
  const base = 10n ** BigInt(places);
  const fraction = (value % base).toString().padStart(places, "0");
  const result = `${value / base}.${fraction}`;
  return trim ? result.replace(/\.?0+$/, "") : result;
}

export function effectiveBuybackRule(settings: BuybackSettings, rules: BuybackRule[], type: BuybackType) {
  const category = rules.find((rule) => rule.scope === "category" && rule.targetId === type.categoryId);
  const item = rules.find((rule) => rule.scope === "type" && rule.targetId === type.typeId);
  return {
    enabled: item?.enabled ?? category?.enabled ?? settings.defaultEnabled,
    priceBasis: item?.priceBasis ?? category?.priceBasis ?? settings.priceBasis,
    ratePercent: item?.ratePercent ?? category?.ratePercent ?? settings.ratePercent,
    fixedPrice: item?.fixedPrice ?? category?.fixedPrice ?? settings.fixedPrice,
  };
}

export function calculateBuybackQuote(inputs: BuybackInput[], settings: BuybackSettings, rules: BuybackRule[], types: Map<string, BuybackType>, prices: Map<number, BuybackMarketPrice>) {
  let total = 0n;
  const lines: BuybackQuoteLine[] = inputs.map((input) => {
    const type = types.get(input.inputName);
    const line: BuybackQuoteLine = {
      inputName: input.inputName, typeId: type?.typeId ?? null, name: type?.name ?? input.inputName,
      quantity: input.quantity, status: "invalid", reason: input.error, priceBasis: null,
      referencePrice: null, ratePercent: null, unitPrice: null, totalIsk: null, marketUpdatedAt: null,
    };
    if (input.error) return line;
    if (!type) return { ...line, status: "unrecognized", reason: "无法精确识别该物品名称，请使用游戏内复制的物品名称。" };
    if (type.categoryId === 9) return { ...line, status: "invalid", reason: "蓝图原图和副本可能共用物品名称，复制清单无法确认类型、流程数和研究等级，请联系管理员人工估价。" };
    const rule = effectiveBuybackRule(settings, rules, type);
    line.priceBasis = rule.priceBasis;
    line.ratePercent = rule.ratePercent;
    if (!rule.enabled) return { ...line, status: "excluded", reason: "管理员已关闭该物品的回收。" };
    const market = prices.get(type.typeId);
    const buy = market?.buy ? decimalUnits(market.buy, 6) : null;
    const sell = market?.sell ? decimalUnits(market.sell, 6) : null;
    let price: bigint | null = null;
    if (rule.priceBasis === "fixed") price = rule.fixedPrice ? decimalUnits(rule.fixedPrice, 6) : null;
    if (rule.priceBasis === "buy") price = buy;
    if (rule.priceBasis === "sell") price = sell;
    if (rule.priceBasis === "mid" && buy !== null && sell !== null && buy > 0n && sell > 0n) price = (buy + sell) / 2n;
    if (price === null || price <= 0n) return { ...line, status: "unpriced", reason: rule.priceBasis === "fixed" ? "尚未设置有效固定单价。" : rule.priceBasis === "mid" ? "计算中间价需要同时存在吉他买单和卖单，请稍后重试或联系管理员。" : "暂无可用吉他市场价格，请稍后重试或联系管理员。" };
    // Six decimal reference precision × hundredths-of-percent = ten decimal unit precision.
    const unit = price * BigInt(Math.round(rule.ratePercent * 100));
    const lineCents = (unit * BigInt(input.quantity) + 50_000_000n) / 100_000_000n;
    if (lineCents <= 0n) return { ...line, status: "unpriced", reason: "该行金额不足 0.01 ISK，无法生成有效合同金额。" };
    if (lineCents > 99_999_999_999_999_999_999n || total + lineCents > 99_999_999_999_999_999_999n) throw new BuybackError(400, "BUYBACK_AMOUNT_LIMIT", "总金额过大，请拆分物品清单。");
    total += lineCents;
    return {
      ...line, status: "accepted", reason: null, referencePrice: formatUnits(price, 6, true),
      unitPrice: formatUnits(unit, 10, true), totalIsk: formatUnits(lineCents, 2),
      marketUpdatedAt: rule.priceBasis === "fixed" ? null : market?.updatedAt ?? null,
    };
  });
  return { lines, totalIsk: formatUnits(total, 2), complete: lines.length > 0 && lines.every((line) => line.status === "accepted") };
}
