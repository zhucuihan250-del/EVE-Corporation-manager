/** A deployment has one existing home corporation. Never elect the first visitor. */
export function selectSiteCorporation<T extends { id: number; isPrimary: boolean; isActive: boolean }>(
  corporations: T[],
  configuredId: string | undefined,
): T | null {
  const configured = configuredId?.trim();
  if (configured) {
    if (!/^[1-9]\d*$/.test(configured)) return null;
    const id = Number(configured);
    if (!Number.isSafeInteger(id)) return null;
    return corporations.find((corporation) => corporation.id === id && corporation.isActive) ?? null;
  }
  // Count inactive primaries too: ambiguous historical flags must not silently
  // choose a different home corporation as an administrator toggles activity.
  const primaries = corporations.filter((corporation) => corporation.isPrimary);
  return primaries.length === 1 && primaries[0].isActive ? primaries[0] : null;
}

export function siteSessionAllowsActor(input: {
  siteCorporationId: number;
  sessionCorporationId?: number;
  sessionCharacterId?: number;
  userId: number;
  actor: {
    userId: number | null;
    corporationId: number | null;
    eveCharacterId: number;
    deletedAt: Date | null;
  } | null;
}): boolean {
  const { actor } = input;
  return Boolean(
    actor
    && (input.sessionCorporationId === undefined || input.sessionCorporationId === input.siteCorporationId)
    && actor.corporationId === input.siteCorporationId
    && actor.userId === input.userId
    && !actor.deletedAt
    && (input.sessionCharacterId === undefined || actor.eveCharacterId === input.sessionCharacterId),
  );
}

export function siteAllowsLogin(siteCorporationId: number, characterCorporationId: number | null): boolean {
  return characterCorporationId === siteCorporationId;
}
