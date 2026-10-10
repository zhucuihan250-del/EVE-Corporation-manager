export function retentionDeadlineLabel(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function characterCorporationLabel(character: {
  corporationName?: string | null;
  actualCorporationId?: number | null;
  membershipStatus?: "unknown" | "member" | "departed";
}, zh: boolean): string {
  if (character.membershipStatus === "departed") {
    return character.actualCorporationId
      ? zh ? `当前军团 ID ${character.actualCorporationId}` : `Current corporation ID ${character.actualCorporationId}`
      : zh ? "当前军团未知" : "Current corporation unknown";
  }
  if (character.membershipStatus === "unknown" || !character.membershipStatus) {
    return zh ? "军团身份待核验" : "Corporation membership not verified";
  }
  return character.corporationName || "—";
}
