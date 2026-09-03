import { charactersTable, db, usersTable, type RequiredSkill, type SkillAuditResult } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { fetchTrainedSkills, refreshSkillTokens, SkillAuditError } from "./identity-skills-client";
export { SkillAuditError } from "./identity-skills-client";

export type SkillPlanForAudit = {
  id: number;
  name: string;
  requiredSkills: RequiredSkill[];
};

export async function auditCharacterSkills(input: {
  userId: number;
  corporationId: number;
  characterId: number;
  requiredSkills: RequiredSkill[];
  skillPlans?: SkillPlanForAudit[];
  skillPlanMatchMode?: "all" | "any";
}): Promise<SkillAuditResult> {
  const [character] = await db
    .select()
    .from(charactersTable)
    .where(
      and(
        eq(charactersTable.id, input.characterId),
        eq(charactersTable.userId, input.userId),
        eq(charactersTable.corporationId, input.corporationId),
        isNull(charactersTable.deletedAt),
      ),
    );
  if (!character) {
    throw new SkillAuditError("Character not found in this corporation", "CHARACTER_NOT_FOUND");
  }

  const effectivePlans = input.skillPlans?.length ? input.skillPlans : null;
  const uniqueRequirements = new Map<number, RequiredSkill>();
  for (const requirement of effectivePlans
    ? effectivePlans.flatMap((plan) => plan.requiredSkills)
    : input.requiredSkills) {
    const existing = uniqueRequirements.get(requirement.skillId);
    if (!existing || requirement.level > existing.level) {
      uniqueRequirements.set(requirement.skillId, requirement);
    }
  }
  if (uniqueRequirements.size === 0) {
    return { checkedAt: new Date().toISOString(), passed: true, skills: [] };
  }

  let accessToken = character.accessToken;
  let refreshToken = character.refreshToken;
  if (!accessToken || !refreshToken || !character.tokenExpiry) {
    throw new SkillAuditError(
      "Please re-authorize this character before applying",
      "SKILL_AUTHORIZATION_REQUIRED",
    );
  }

  if (character.tokenExpiry.getTime() <= Date.now() + 60_000) {
    const refreshed = await refreshSkillTokens(refreshToken);
    accessToken = refreshed.accessToken;
    refreshToken = refreshed.refreshToken;
    const tokenExpiry = new Date(Date.now() + refreshed.expiresIn * 1000);
    await db
      .update(charactersTable)
      .set({ accessToken, refreshToken, tokenExpiry })
      .where(eq(charactersTable.id, character.id));
    if (character.isMain) {
      await db
        .update(usersTable)
        .set({ accessToken, refreshToken, tokenExpiry })
        .where(eq(usersTable.id, input.userId));
    }
  }

  const trained = await fetchTrainedSkills(character.eveCharacterId, accessToken);
  const auditRequirements = (requirements: RequiredSkill[]) => requirements.map((requirement) => {
    const trainedLevel = trained.get(requirement.skillId) ?? 0;
    return {
      ...requirement,
      trainedLevel,
      passed: trainedLevel >= requirement.level,
    };
  });
  const skills = auditRequirements([...uniqueRequirements.values()]);
  if (effectivePlans) {
    const plans = effectivePlans.map((plan) => {
      const planSkills = auditRequirements(plan.requiredSkills);
      return {
        planId: plan.id,
        name: plan.name,
        passed: planSkills.every((skill) => skill.passed),
        skills: planSkills,
      };
    });
    const matchMode = input.skillPlanMatchMode ?? "all";
    return {
      checkedAt: new Date().toISOString(),
      passed: matchMode === "any"
        ? plans.some((plan) => plan.passed)
        : plans.every((plan) => plan.passed),
      skills,
      matchMode,
      plans,
    };
  }
  return {
    checkedAt: new Date().toISOString(),
    passed: skills.every((skill) => skill.passed),
    skills,
  };
}
