import { charactersTable, usersTable } from "@workspace/db/schema";
import type { db } from "@workspace/db";
import { and, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";

/** Only owned, authorized website characters count as bound; fleet-discovered orphans do not. */
export async function getWebsiteBoundCharacterIds(corporationId: number, database: typeof db): Promise<Set<number>> {
  const [boundCharacters, boundMainCharacters] = await Promise.all([
    database.select({ characterId: charactersTable.eveCharacterId })
      .from(charactersTable)
      .innerJoin(usersTable, eq(usersTable.id, charactersTable.userId))
      .where(and(
        eq(charactersTable.corporationId, corporationId),
        isNull(charactersTable.deletedAt),
        ne(charactersTable.membershipStatus, "departed"),
        isNotNull(usersTable.eveCharacterId),
        or(isNotNull(charactersTable.accessToken), isNotNull(charactersTable.refreshToken)),
      )),
    database.select({ characterId: usersTable.eveCharacterId })
      .from(usersTable)
      .where(and(
        eq(usersTable.corporationId, corporationId),
        isNotNull(usersTable.eveCharacterId),
        or(isNotNull(usersTable.accessToken), isNotNull(usersTable.refreshToken)),
        sql`NOT EXISTS (SELECT 1 FROM ${charactersTable} AS unavailable_character
          WHERE unavailable_character.user_id = ${usersTable.id}
            AND unavailable_character.eve_character_id = ${usersTable.eveCharacterId}
            AND (unavailable_character.deleted_at IS NOT NULL OR unavailable_character.membership_status = 'departed'))`,
      )),
  ]);
  return new Set<number>([
    ...boundCharacters.map((item) => item.characterId),
    ...boundMainCharacters.flatMap((item) => item.characterId === null ? [] : [item.characterId]),
  ]);
}
