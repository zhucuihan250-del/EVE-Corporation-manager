export const PAP_MARKET_ISK_PER_PAP = 100_000_000;
export const MAX_PAP_MARKET_ORDER = 1_000_000;

const PRECISION = 1_000_000;

export function normalizeMarketPap(value: number): number {
  const amount = Math.round((value + Number.EPSILON) * PRECISION) / PRECISION;
  if (!Number.isFinite(amount) || amount <= 0 || amount > MAX_PAP_MARKET_ORDER) {
    throw new Error("PAP amount is outside the supported range");
  }
  return amount;
}

export function calculatePapMarketIskValue(amount: number): number {
  const value = Math.round(normalizeMarketPap(amount) * PAP_MARKET_ISK_PER_PAP);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("PAP amount is outside the supported range");
  }
  return value;
}

export function nextPapMarketOrderStatus(
  remaining: number,
  matched: number,
): "open" | "partially_filled" | "filled" {
  if (remaining <= 0) return "filled";
  return matched > 0 ? "partially_filled" : "open";
}

export function settlePapTransfer(input: {
  sellerBalance: number;
  sellerLocked: number;
  buyerBalance: number;
  amount: number;
}) {
  const amount = normalizeMarketPap(input.amount);
  if (input.sellerBalance < amount || input.sellerLocked < amount) {
    throw new Error("Seller locked PAP is insufficient");
  }
  const normalize = (value: number) => Math.round((value + Number.EPSILON) * PRECISION) / PRECISION;
  const sellerBalance = normalize(input.sellerBalance - amount);
  const sellerLocked = normalize(input.sellerLocked - amount);
  const buyerBalance = normalize(input.buyerBalance + amount);
  return { sellerBalance, sellerLocked, buyerBalance };
}
