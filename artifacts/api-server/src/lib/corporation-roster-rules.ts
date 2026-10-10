const DAY_MS = 24 * 60 * 60 * 1_000;

export type MemberTrackingEntry = {
  character_id: number;
  start_date?: string;
};

export type UnboundCorporationMember = {
  characterId: number;
  characterName: string;
  corporationJoinedAt: Date | null;
  daysInCorporation: number | null;
  joinDateKnown: boolean;
};

export function buildUnboundCorporationMemberAudit(input: {
  tracking: MemberTrackingEntry[];
  boundIds: ReadonlySet<number>;
  names?: ReadonlyMap<number, string>;
  now: Date;
  windowDays: number;
}) {
  const currentMembers = new Map<number, { characterId: number; corporationJoinedAt: Date | null }>();
  for (const entry of input.tracking) {
    if (!Number.isSafeInteger(entry.character_id) || entry.character_id <= 0) continue;
    const joinedAt = typeof entry.start_date === "string" ? new Date(entry.start_date) : null;
    const corporationJoinedAt = joinedAt && Number.isFinite(joinedAt.getTime())
      && joinedAt.getTime() <= input.now.getTime() ? joinedAt : null;
    // Duplicate ESI rows must never create duplicate member alerts.
    const existing = currentMembers.get(entry.character_id);
    if (!existing || (!existing.corporationJoinedAt && corporationJoinedAt)) {
      currentMembers.set(entry.character_id, { characterId: entry.character_id, corporationJoinedAt });
    }
  }
  const cutoff = input.now.getTime() - input.windowDays * DAY_MS;
  const reviewed = [...currentMembers.values()];
  const members: UnboundCorporationMember[] = reviewed
    .filter((member) => !input.boundIds.has(member.characterId))
    .map((member) => ({
      ...member,
      characterName: input.names?.get(member.characterId) ?? `Character ${member.characterId}`,
      daysInCorporation: member.corporationJoinedAt
        ? Math.max(0, Math.floor((input.now.getTime() - member.corporationJoinedAt.getTime()) / DAY_MS)) : null,
      joinDateKnown: member.corporationJoinedAt !== null,
    }))
    .sort((left, right) => (
      (right.corporationJoinedAt?.getTime() ?? 0) - (left.corporationJoinedAt?.getTime() ?? 0)
      || left.characterName.localeCompare(right.characterName)
    ));
  return {
    // Kept for old clients only: membership review is no longer restricted by this window.
    windowDays: input.windowDays,
    auditScope: "all" as const,
    totalCorporationMembers: reviewed.length,
    reviewedMemberCount: reviewed.length,
    recentMemberCount: reviewed.filter((member) => member.corporationJoinedAt && member.corporationJoinedAt.getTime() >= cutoff).length,
    unknownJoinDateCount: reviewed.filter((member) => !member.corporationJoinedAt).length,
    unboundMemberCount: members.length,
    members,
  };
}
