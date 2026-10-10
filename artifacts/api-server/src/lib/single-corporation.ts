import { corporationsTable, db } from "@workspace/db";
import { eq } from "drizzle-orm";
import { selectSiteCorporation } from "./single-corporation-rules";
import { recordVerifiedCharacterMembership } from "./character-membership";

export async function getSiteCorporation(): Promise<typeof corporationsTable.$inferSelect | null> {
  const configured = process.env.PRIMARY_CORPORATION_ID?.trim();
  // An invalid explicit configuration must fail closed, not fall back to a row.
  if (configured && (!/^[1-9]\d*$/.test(configured) || !Number.isSafeInteger(Number(configured)))) return null;
  const candidates = await db.select().from(corporationsTable).where(
    configured ? eq(corporationsTable.id, Number(configured)) : eq(corporationsTable.isPrimary, true),
  );
  return selectSiteCorporation(candidates, configured);
}

export async function requireSiteCorporation(): Promise<typeof corporationsTable.$inferSelect> {
  const corporation = await getSiteCorporation();
  if (!corporation) throw new Error("The site's home corporation is unavailable or ambiguous");
  return corporation;
}

/** A verified departure must invalidate other sessions using stale home data. */
export async function recordNonSiteLoginAffiliation(characterId: number, corporationId: number): Promise<void> {
  // A failed/unknown ESI affiliation is not evidence of a departure.
  if (!Number.isSafeInteger(characterId) || characterId <= 0
    || !Number.isSafeInteger(corporationId) || corporationId <= 0) return;
  const site = await requireSiteCorporation();
  if (corporationId === site.id) return;
  // Keep historical identity-group FKs intact while invalidating live access.
  await recordVerifiedCharacterMembership(db, site.id, characterId, corporationId);
}

/** External alts need a foreign-key reference, never a second enabled website. */
export async function ensureCharacterCorporationReference(corporationId: number, name: string): Promise<void> {
  if (!Number.isSafeInteger(corporationId) || corporationId <= 0) throw new Error("A verified EVE corporation is required");
  await db.insert(corporationsTable).values({
    id: corporationId,
    name: name || `Corporation ${corporationId}`,
    isPrimary: false,
    isActive: false,
    papEnabled: false,
    identityEnabled: false,
    economyEnabled: false,
    fleetEnabled: false,
    reimbursementEnabled: false,
    reimbursementOpen: false,
    diplomacyEnabled: false,
    courierEnabled: false,
    structuresEnabled: false,
  }).onConflictDoNothing();
}
