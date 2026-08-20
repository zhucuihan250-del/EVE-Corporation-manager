export const ACTIVITY_MONTHLY_PAP_DEDUCTION = 2;

const PAP_PRECISION = 1_000_000;

function normalizePap(value: number): number {
  return Math.round((value + Number.EPSILON) * PAP_PRECISION) / PAP_PRECISION;
}

export function calculateActivityPapDeduction(availableBalance: number): {
  deductedPap: number;
  shortfallPap: number;
  hasInsufficientPap: boolean;
} {
  const available = normalizePap(Math.max(0, Number(availableBalance) || 0));
  const deductedPap = normalizePap(Math.min(available, ACTIVITY_MONTHLY_PAP_DEDUCTION));
  const shortfallPap = normalizePap(ACTIVITY_MONTHLY_PAP_DEDUCTION - deductedPap);
  return { deductedPap, shortfallPap, hasInsufficientPap: shortfallPap > 0 };
}
