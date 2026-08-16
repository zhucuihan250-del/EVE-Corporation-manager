import { usersTable } from "@workspace/db";
import { sql } from "drizzle-orm";

const PAP_PRECISION = 1_000_000;

export function normalizePap(value: number): number {
  return Math.round((value + Number.EPSILON) * PAP_PRECISION) / PAP_PRECISION;
}

export function canonicalPapBalance(value: number): number {
  return normalizePap(Math.max(0, Number(value) || 0));
}

export function setPapBalance(value: number) {
  const balance = canonicalPapBalance(value);
  return {
    // totalPap remains as a mirrored compatibility field for older clients.
    totalPap: balance,
    redeemablePap: balance,
  };
}

export function incrementPapBalance(amount: number) {
  const delta = normalizePap(amount);
  const nextBalance = () => sql<number>`GREATEST(
    0::real,
    ROUND((${usersTable.redeemablePap})::numeric + ${delta}::numeric, 6)::real
  )`;

  return {
    // Generate the expression twice so Drizzle can bind each assignment safely.
    totalPap: nextBalance(),
    redeemablePap: nextBalance(),
  };
}
