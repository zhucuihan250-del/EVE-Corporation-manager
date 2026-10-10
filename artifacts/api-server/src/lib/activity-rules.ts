export const ACTIVITY_MONTHLY_PAP_DEDUCTION = 2;
export const ACTIVITY_PAP_ALERT_THRESHOLD_MONTHS = 3;

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

export function previousActivityMonth(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Invalid activity month");
  const [year, monthNumber] = month.split("-").map(Number);
  const previous = new Date(Date.UTC(year, monthNumber - 2, 1));
  return `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Missing personal deductions or missing settlements are unknown, not a zero PAP deduction. */
export function countConsecutiveInsufficientActivityMonths(input: {
  anchorMonth: string;
  settledMonths: ReadonlySet<string>;
  deductedPapByMonth: ReadonlyMap<string, number>;
}): number {
  let month = input.anchorMonth;
  let consecutiveMonths = 0;
  while (input.settledMonths.has(month)) {
    const deductedPap = input.deductedPapByMonth.get(month);
    if (deductedPap === undefined || !Number.isFinite(deductedPap) || deductedPap < 0
      || !calculateActivityPapDeduction(deductedPap).hasInsufficientPap) break;
    consecutiveMonths += 1;
    month = previousActivityMonth(month);
  }
  return consecutiveMonths;
}
