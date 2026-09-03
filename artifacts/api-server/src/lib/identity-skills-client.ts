import { EveTokenRefreshError, refreshAccessToken } from "./eve-sso";

export class SkillAuditError extends Error {
  constructor(
    message: string,
    readonly code: "CHARACTER_NOT_FOUND" | "SKILL_AUTHORIZATION_REQUIRED" | "ESI_SKILLS_UNAVAILABLE",
  ) {
    super(message);
    this.name = "SkillAuditError";
  }
}

function unavailable(): SkillAuditError {
  return new SkillAuditError("EVE skill data is temporarily unavailable", "ESI_SKILLS_UNAVAILABLE");
}

export async function refreshSkillTokens(refreshToken: string) {
  try {
    const tokens = await refreshAccessToken(refreshToken);
    if (typeof tokens.accessToken !== "string" || !tokens.accessToken
      || typeof tokens.refreshToken !== "string" || !tokens.refreshToken
      || !Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0) {
      throw unavailable();
    }
    return tokens;
  } catch (error) {
    if (error instanceof EveTokenRefreshError && error.authorizationRequired) {
      throw new SkillAuditError(
        "Please re-authorize this character through EVE SSO; unlinking is not required",
        "SKILL_AUTHORIZATION_REQUIRED",
      );
    }
    throw unavailable();
  }
}

export async function fetchTrainedSkills(characterId: number, accessToken: string): Promise<Map<number, number>> {
  try {
    const response = await fetch(
      `https://esi.evetech.net/latest/characters/${characterId}/skills/?datasource=tranquility`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.status === 401 || response.status === 403) {
      throw new SkillAuditError(
        "Please re-authorize this character with skill access through EVE SSO",
        "SKILL_AUTHORIZATION_REQUIRED",
      );
    }
    if (!response.ok) throw unavailable();

    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || !("skills" in payload)
      || !Array.isArray(payload.skills)) throw unavailable();

    const trained = new Map<number, number>();
    for (const skill of payload.skills) {
      if (!skill || !Number.isInteger(skill.skill_id) || skill.skill_id <= 0
        || !Number.isInteger(skill.trained_skill_level)
        || skill.trained_skill_level < 0 || skill.trained_skill_level > 5) {
        throw unavailable();
      }
      trained.set(skill.skill_id, skill.trained_skill_level);
    }
    return trained;
  } catch (error) {
    if (error instanceof SkillAuditError) throw error;
    // Network failures, timeouts and invalid JSON are unavailable data, not
    // missing skills or a failed skill-plan audit.
    throw unavailable();
  }
}
