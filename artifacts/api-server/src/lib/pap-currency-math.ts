export const PAP_SCALE = 1_000_000n;
export const MAX_PAP = 1_000_000_000n * PAP_SCALE;
export const MAX_PAP_RATE = 1_000_000n * PAP_SCALE;

export class PapCurrencyError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/** Parse user decimal strings without IEEE-754 arithmetic or silent rounding. */
export function parsePapDecimal(value: unknown, scale = 6, signed = false, max = MAX_PAP): bigint {
  if (typeof value !== "string" || value.length > 40 || !new RegExp(`^${signed ? "-?" : ""}\\d+(?:\\.\\d{1,${scale}})?$`).test(value)) {
    throw new PapCurrencyError(400, "PAP_INVALID_DECIMAL", `请输入有效数字，最多 ${scale} 位小数。`);
  }
  const negative = value.startsWith("-");
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  const result = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, "0"));
  if (result > max) throw new PapCurrencyError(400, "PAP_AMOUNT_LIMIT", "数量或汇率超过允许上限。");
  return negative ? -result : result;
}

export function formatPapUnits(value: bigint, scale = 6): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  return `${negative ? "-" : ""}${absolute / divisor}.${String(absolute % divisor).padStart(scale, "0")}`;
}

/** Legacy common PAP is a double column. Quantize only when entering the new
 * six-place workflow; never rewrite unrelated members or historical balances. */
export function commonPapUnits(value: number): bigint {
  if (!Number.isFinite(value) || value < 0 || value > 1_000_000_000) throw new PapCurrencyError(409, "PAP_LEGACY_BALANCE_LIMIT", "通用 PAP 余额超出本次兑换支持范围，请联系管理员。");
  return parsePapDecimal(value.toFixed(6));
}

export function calculatePapConversion(amount: bigint, rate: bigint, carry: bigint) {
  if (amount <= 0n || amount > MAX_PAP || rate <= 0n || rate > MAX_PAP_RATE || carry < 0n || carry >= PAP_SCALE) {
    throw new PapCurrencyError(400, "PAP_INVALID_CONVERSION", "兑换数量、比例或尾数无效。");
  }
  const exact = amount * rate + carry;
  const commonAmount = exact / PAP_SCALE;
  if (commonAmount === 0n) throw new PapCurrencyError(400, "PAP_CONVERSION_TOO_SMALL", "本次兑换不足 0.000001 通用 PAP，请增加数量后重试；余额未扣除。");
  if (commonAmount > MAX_PAP) throw new PapCurrencyError(400, "PAP_AMOUNT_LIMIT", "兑换结果超过 1,000,000,000 PAP，请减少数量。");
  return { commonAmount, carryAfter: exact % PAP_SCALE };
}

export function validatePapRequestId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new PapCurrencyError(400, "PAP_INVALID_REQUEST_ID", "请求标识无效，请刷新后重试。");
  }
  return value.toLowerCase();
}

export function assertPapVersion(value: unknown, current: number, wallet = false) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) >= 2_147_483_646) throw new PapCurrencyError(400, "PAP_INVALID_VERSION", "版本无效，请刷新后重试。");
  if (value !== current) throw new PapCurrencyError(409, wallet ? "PAP_WALLET_CONFLICT" : "PAP_VERSION_CONFLICT", wallet ? "PAP 余额已经变化，请重新预览。" : "PAP 种类或兑换比例已修改，请刷新后重新预览。");
}
