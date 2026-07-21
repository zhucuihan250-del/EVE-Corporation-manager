import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

const ESI_BASE = "https://esi.evetech.net/latest";

type MembershipUser = Pick<typeof usersTable.$inferSelect, "id" | "eveCharacterId" | "corporationId" | "corporationJoinedAt">;

type CorporationHistoryEntry = {
  corporation_id: number;
  start_date: string;
};

export async function getCorporationJoinDate(characterId: number, corporationId: number): Promise<Date | null> {
  try {
    const response = await fetch(`${ESI_BASE}/characters/${characterId}/corporationhistory/?datasource=tranquility`, { headers: { Accept: "application/json" } });

    if (!response.ok) {
      logger.warn({ characterId, corporationId, status: response.status }, "Failed to fetch corporation history from ESI");
      return null;
    }

    const history = (await response.json()) as CorporationHistoryEntry[];
    const matchingDates = history
      .filter((entry) => entry.corporation_id === corporationId)
      .map((entry) => new Date(entry.start_date))
      .filter((date) => !Number.isNaN(date.getTime()))
      .sort((a, b) => b.getTime() - a.getTime());

    return matchingDates[0] ?? null;
  } catch (error) {
    logger.warn({ error, characterId, corporationId }, "Unable to resolve corporation join date");
    return null;
  }
}

export async function ensureCorporationJoinedAt(user: MembershipUser): Promise<Date | null> {
  if (user.corporationJoinedAt) {
    return user.corporationJoinedAt;
  }

  if (!user.eveCharacterId || !user.corporationId) {
    return null;
  }

  const joinedAt = await getCorporationJoinDate(user.eveCharacterId, user.corporationId);
  if (!joinedAt) {
    return null;
  }

  await db.update(usersTable).set({ corporationJoinedAt: joinedAt }).where(eq(usersTable.id, user.id));

  return joinedAt;
}

export function addCalendarMonths(date: Date, months: number): Date {
  const result = new Date(date);
  const originalDay = result.getUTCDate();

  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);

  const lastDayOfTargetMonth = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(originalDay, lastDayOfTargetMonth));

  return result;
}
