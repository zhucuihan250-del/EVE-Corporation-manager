import { and, isNotNull, isNull, lte, or } from "drizzle-orm";
import { charactersTable, db } from "@workspace/db";

export const CHARACTER_RETENTION_MONTHS = 3;
export const CHARACTER_RETENTION_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function getCharacterRetentionDeadline(deletedAt: Date): Date {
  const targetYear = deletedAt.getUTCFullYear();
  const targetMonth = deletedAt.getUTCMonth() + CHARACTER_RETENTION_MONTHS;
  const lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  const targetDay = Math.min(deletedAt.getUTCDate(), lastDayOfTargetMonth);

  return new Date(Date.UTC(
    targetYear,
    targetMonth,
    targetDay,
    deletedAt.getUTCHours(),
    deletedAt.getUTCMinutes(),
    deletedAt.getUTCSeconds(),
    deletedAt.getUTCMilliseconds(),
  ));
}

export async function purgeExpiredDeletedCharacters(now = new Date()): Promise<number> {
  const deleted = await db
    .delete(charactersTable)
    .where(and(
      isNotNull(charactersTable.deletedAt),
      or(
        isNull(charactersTable.retainedUntil),
        lte(charactersTable.retainedUntil, now),
      ),
    ))
    .returning({ id: charactersTable.id });

  return deleted.length;
}
