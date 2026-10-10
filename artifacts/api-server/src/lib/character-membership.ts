import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { charactersTable, corporationMembershipsTable, corporationRosterConnectionsTable, corporationWalletConnectionsTable, corporationStructureConnectionsTable, usersTable } from "@workspace/db";
import type { db } from "@workspace/db";
import { addCalendarMonths } from "./corporation-membership";

type Database = Pick<typeof db, "select" | "insert" | "transaction">;
export const MEMBERSHIP_RETENTION_MONTHS = 3;
const ESI_AFFILIATION_URL = "https://esi.evetech.net/latest/characters/affiliation/?datasource=tranquility";

export function verifiedMembershipFields(homeCorporationId: number, actualCorporationId: number, now = new Date(), previous?: Pick<typeof charactersTable.$inferSelect, "membershipStatus" | "corporationLeftAt" | "membershipRetainedUntil">) {
  const isMember = actualCorporationId === homeCorporationId;
  const leftAt = !isMember && previous?.membershipStatus === "departed" && previous.corporationLeftAt ? previous.corporationLeftAt : now;
  return {
    actualCorporationId,
    retentionCorporationId: homeCorporationId,
    membershipStatus: isMember ? "member" as const : "departed" as const,
    membershipCheckedAt: now,
    corporationLeftAt: isMember ? null : leftAt,
    membershipRetainedUntil: isMember ? null : previous?.membershipStatus === "departed" && previous.membershipRetainedUntil
      ? previous.membershipRetainedUntil : addCalendarMonths(leftAt, MEMBERSHIP_RETENTION_MONTHS),
  };
}

/** Missing, malformed or failed ESI responses are not departure evidence. */
export async function fetchVerifiedAffiliations(characterIds: number[], fetcher: typeof fetch = fetch, freshness?: { now: Date; maxAgeMs: number; requireDate?: boolean; evidenceByCharacter?: Map<number, Date> }): Promise<Map<number, number>> {
  const readStarted = performance.now();
  const results = new Map<number, number>();
  const ids = [...new Set(characterIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  for (let offset = 0; offset < ids.length; offset += 1_000) {
    const batch = ids.slice(offset, offset + 1_000);
    try {
      const response = await fetcher(ESI_AFFILIATION_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "User-Agent": "EVE-Corporation-Manager/1.0" },
        body: JSON.stringify(batch),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      let evidenceAt: Date | null = null;
      if (freshness) {
        const dateHeader = response.headers.get("date");
        if (freshness.requireDate && !dateHeader) continue;
        if (dateHeader) {
          const date = Date.parse(dateHeader), ageText = response.headers.get("age") ?? "0";
          const age = /^\d+$/.test(ageText) ? Number(ageText) : NaN;
          const current = freshness.now.getTime() + Math.max(0, performance.now() - readStarted);
          const evidence = Math.min(date, current - age * 1000);
          if (!Number.isFinite(evidence) || !Number.isFinite(age) || date > current + 5_000 || current - evidence > freshness.maxAgeMs) continue;
          evidenceAt = new Date(evidence);
          const expires = response.headers.get("expires");
          if (expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) < current)) continue;
        }
      }
      const body: unknown = await response.json();
      if (!Array.isArray(body)) continue;
      const requested = new Set(batch);
      const valid = new Map<number, number>();
      const duplicates = new Set<number>();
      for (const row of body) {
        if (!row || typeof row !== "object") continue;
        const characterId = (row as Record<string, unknown>).character_id;
        const corporationId = (row as Record<string, unknown>).corporation_id;
        if (typeof characterId !== "number" || !requested.has(characterId)
          || typeof corporationId !== "number" || !Number.isSafeInteger(corporationId) || corporationId <= 0) continue;
        if (valid.has(characterId)) duplicates.add(characterId);
        valid.set(characterId, corporationId);
      }
      for (const [id, corporationId] of valid) if (!duplicates.has(id)) {
        results.set(id, corporationId);
        if (evidenceAt) freshness?.evidenceByCharacter?.set(id, evidenceAt);
      }
    } catch {
      // Retry next sweep; do not advance retention or purge on an outage.
    }
  }
  return results;
}

/** Preserve the historical corporation FK; live affiliation has its own fields. */
export async function recordVerifiedCharacterMembership(
  database: Database, homeCorporationId: number, eveCharacterId: number, actualCorporationId: number,
  now = new Date(), evidenceAt = now,
): Promise<number> {
  if (!Number.isSafeInteger(eveCharacterId) || eveCharacterId <= 0
    || !Number.isSafeInteger(actualCorporationId) || actualCorporationId <= 0) return 0;
  return database.transaction(async (tx) => {
    // Account merge and settlement also lock users before character rows.
    const owners = await tx.select().from(usersTable).where(eq(usersTable.eveCharacterId, eveCharacterId)).for("update");
    const rows = await tx.select().from(charactersTable).where(and(
      eq(charactersTable.eveCharacterId, eveCharacterId), isNull(charactersTable.deletedAt),
    )).for("update");
    if (rows.some((character) => character.membershipCheckedAt && character.membershipCheckedAt.getTime() > evidenceAt.getTime())) return 0;
    let changed = 0;
    for (const character of rows) {
      if (!(character.accessToken || character.refreshToken)
        && !owners.some((owner) => owner.id === character.userId && (owner.accessToken || owner.refreshToken))) continue;
      const [ownerMembership] = character.userId ? await tx.select({ id: corporationMembershipsTable.id })
        .from(corporationMembershipsTable).where(and(
          eq(corporationMembershipsTable.userId, character.userId),
          eq(corporationMembershipsTable.corporationId, homeCorporationId),
        )).limit(1) : [];
      if (character.retentionCorporationId !== homeCorporationId
        && character.corporationId !== homeCorporationId && !ownerMembership) continue;
      const fields = verifiedMembershipFields(homeCorporationId, actualCorporationId, now);
      if (fields.membershipStatus === "departed" && character.membershipStatus === "departed" && character.corporationLeftAt) {
        fields.corporationLeftAt = character.corporationLeftAt;
        fields.membershipRetainedUntil = character.membershipRetainedUntil
          ?? addCalendarMonths(character.corporationLeftAt, MEMBERSHIP_RETENTION_MONTHS);
      }
      await tx.update(charactersTable).set({
        ...fields,
        ...(fields.membershipStatus === "member" ? { corporationId: homeCorporationId } : {}),
      }).where(eq(charactersTable.id, character.id));
      changed += 1;
    }
    // Prevent obsolete main-character data from causing deductions or access.
    for (const owner of owners) {
      if (!(owner.accessToken || owner.refreshToken)) continue;
      const [membership] = await tx.select({ id: corporationMembershipsTable.id }).from(corporationMembershipsTable)
        .where(and(eq(corporationMembershipsTable.userId, owner.id), eq(corporationMembershipsTable.corporationId, homeCorporationId))).limit(1);
      if (!membership && owner.corporationId !== homeCorporationId) continue;
      await tx.update(usersTable).set({
        corporationId: actualCorporationId,
        ...(actualCorporationId !== homeCorporationId ? { corporationJoinedAt: null } : {}),
      }).where(eq(usersTable.id, owner.id));
    }
    return changed;
  });
}

export async function synchronizeCharacterMemberships(database: Database, homeCorporationId: number, now = new Date(), fetcher: typeof fetch = fetch) {
  // Legacy authorized main identities may predate the characters table. Create
  // only the missing authorization row, never a PAP wallet or an orphan login.
  const authorizedUsers = await database.select({ user: usersTable }).from(usersTable)
    .innerJoin(corporationMembershipsTable, and(eq(corporationMembershipsTable.userId, usersTable.id), eq(corporationMembershipsTable.corporationId, homeCorporationId)))
    .where(and(isNotNull(usersTable.eveCharacterId), or(isNotNull(usersTable.refreshToken), isNotNull(usersTable.accessToken))));
  for (const { user } of authorizedUsers) {
    await database.transaction(async (tx) => {
      const [lockedUser] = await tx.select().from(usersTable).where(eq(usersTable.id, user.id)).for("update");
      if (!lockedUser?.eveCharacterId || !(lockedUser.accessToken || lockedUser.refreshToken)) return;
      const [existing] = await tx.select({ id: charactersTable.id }).from(charactersTable).where(eq(charactersTable.eveCharacterId, lockedUser.eveCharacterId)).limit(1);
      if (!existing) await tx.insert(charactersTable).values({
        userId: user.id, eveCharacterId: lockedUser.eveCharacterId, eveCharacterName: lockedUser.eveCharacterName ?? `Character ${lockedUser.eveCharacterId}`,
        corporationId: homeCorporationId, retentionCorporationId: homeCorporationId, isMain: true,
        accessToken: lockedUser.accessToken, refreshToken: lockedUser.refreshToken, tokenExpiry: lockedUser.tokenExpiry,
      });
    });
  }
  const candidates = await database.select({ character: charactersTable }).from(charactersTable)
    .leftJoin(corporationMembershipsTable, and(eq(corporationMembershipsTable.userId, charactersTable.userId), eq(corporationMembershipsTable.corporationId, homeCorporationId)))
    .where(and(isNull(charactersTable.deletedAt), isNotNull(charactersTable.userId),
      or(isNotNull(charactersTable.refreshToken), isNotNull(charactersTable.accessToken)),
      or(eq(charactersTable.corporationId, homeCorporationId), eq(charactersTable.retentionCorporationId, homeCorporationId), isNotNull(corporationMembershipsTable.id))));
  const evidenceByCharacter = new Map<number, Date>();
  const affiliations = await fetchVerifiedAffiliations(candidates.map(({ character }) => character.eveCharacterId), fetcher, { now, maxAgeMs: 3_600_000, evidenceByCharacter });
  let confirmed = 0;
  for (const [id, corporationId] of affiliations) confirmed += await recordVerifiedCharacterMembership(database, homeCorporationId, id, corporationId, now, evidenceByCharacter.get(id) ?? now);
  return { checked: candidates.length, confirmed, unavailable: candidates.length - confirmed };
}

/** A fresh ESI confirmation and locked state are both required before deletion. */
export async function purgeExpiredDepartedCharacters(database: Database, homeCorporationId: number, now = new Date(), fetcher: typeof fetch = fetch): Promise<number> {
  const candidates = await database.select().from(charactersTable).where(and(
    eq(charactersTable.retentionCorporationId, homeCorporationId), eq(charactersTable.membershipStatus, "departed"),
    isNull(charactersTable.deletedAt),
  ));
  const expired = candidates.filter((row) => row.membershipRetainedUntil && row.membershipRetainedUntil.getTime() <= now.getTime());
  const affiliations = await fetchVerifiedAffiliations(expired.map((row) => row.eveCharacterId), fetcher, { now, maxAgeMs: 120_000, requireDate: true });
  let count = 0;
  for (const snapshot of expired) {
    const actualCorporationId = affiliations.get(snapshot.eveCharacterId);
    if (!actualCorporationId) continue;
    if (actualCorporationId === homeCorporationId) {
      await recordVerifiedCharacterMembership(database, homeCorporationId, snapshot.eveCharacterId, actualCorporationId, now);
      continue;
    }
    count += await database.transaction(async (tx) => {
      const owners = await tx.select().from(usersTable).where(eq(usersTable.eveCharacterId, snapshot.eveCharacterId)).for("update");
      const [current] = await tx.select().from(charactersTable).where(eq(charactersTable.id, snapshot.id)).for("update");
      if (!current || current.membershipStatus !== "departed" || current.deletedAt
        || current.retentionCorporationId !== homeCorporationId || !current.membershipRetainedUntil
        || current.membershipRetainedUntil.getTime() > now.getTime()
        || current.updatedAt.getTime() !== snapshot.updatedAt.getTime()) return 0;
      for (const owner of owners) await tx.update(usersTable).set({
        eveCharacterId: null, eveCharacterName: null, corporationId: null, corporationName: null,
        corporationJoinedAt: null, accessToken: null, refreshToken: null, tokenExpiry: null,
      }).where(and(eq(usersTable.id, owner.id), eq(usersTable.eveCharacterId, current.eveCharacterId)));
      // These director credentials use EVE IDs rather than a character-row FK.
      // Remove only this departing pilot's connections, never the fetched data.
      for (const table of [corporationRosterConnectionsTable, corporationWalletConnectionsTable, corporationStructureConnectionsTable]) {
        await tx.delete(table).where(and(eq(table.corporationId, homeCorporationId), eq(table.characterId, current.eveCharacterId)));
      }
      await tx.delete(charactersTable).where(eq(charactersTable.id, current.id));
      return 1;
    });
  }
  return count;
}
