import { charactersTable, usersTable } from "@workspace/db/schema";
import { and, isNotNull, or, sql } from "drizzle-orm";

/** A retained/deleted main character is never a currently eligible PAP member. */
export function activeAuthorizedActivityMemberPredicate() {
  return and(
    isNotNull(usersTable.eveCharacterId),
    isNotNull(usersTable.eveCharacterName),
    or(
      isNotNull(usersTable.accessToken),
      isNotNull(usersTable.refreshToken),
      sql`EXISTS (SELECT 1 FROM ${charactersTable} AS authorized_character
        WHERE authorized_character.user_id = ${usersTable.id}
          AND authorized_character.eve_character_id = ${usersTable.eveCharacterId}
          AND authorized_character.deleted_at IS NULL
          AND (authorized_character.access_token IS NOT NULL OR authorized_character.refresh_token IS NOT NULL))`,
    ),
    sql`NOT EXISTS (SELECT 1 FROM ${charactersTable} AS unavailable_character
      WHERE unavailable_character.user_id = ${usersTable.id}
        AND unavailable_character.eve_character_id = ${usersTable.eveCharacterId}
        AND (unavailable_character.deleted_at IS NOT NULL OR unavailable_character.membership_status = 'departed'))`,
  );
}
