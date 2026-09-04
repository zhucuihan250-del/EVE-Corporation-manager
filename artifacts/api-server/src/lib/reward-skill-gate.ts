import {
  charactersTable,
  corporationSkillPlansTable,
  identityGroupMembershipsTable,
  identityGroupsTable,
  rewardSkillPlansTable,
  type Reward,
  type SkillAuditResult,
} from "@workspace/db/schema";
import { db } from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { auditCharacterSkills } from "./identity-skills";
import { activeRewardGroupConditions, rewardMembershipConditions } from "./reward-access";

type RewardTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class RewardSkillGateError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "RewardSkillGateError";
  }
}

export type RewardSkillPlanSummary = {
  id: number;
  name: string;
  description: string;
  requiredSkillCount: number;
  isActive: boolean;
};

export type RewardSkillGate = {
  characterId: number | null;
  membershipCharacterId: number | null;
  matchMode: "all" | "any";
  plans: Array<{
    id: number;
    name: string;
    requiredSkills: (typeof corporationSkillPlansTable.$inferSelect)["requiredSkills"];
    isActive: boolean;
    updatedAt: Date;
  }>;
  snapshot: string;
};

function serializeRewardSkillGate(gate: Omit<RewardSkillGate, "snapshot">): string {
  return JSON.stringify({
    characterId: gate.characterId,
    membershipCharacterId: gate.membershipCharacterId,
    matchMode: gate.matchMode,
    plans: gate.plans.map((plan) => ({
      id: plan.id,
      isActive: plan.isActive,
      updatedAt: plan.updatedAt.toISOString(),
      requiredSkills: plan.requiredSkills,
    })),
  });
}

async function readRewardSkillGate(
  tx: RewardTransaction,
  corporationId: number,
  userId: number,
  reward: Pick<Reward, "id" | "identityGroupId" | "skillPlanMatchMode">,
  lock: boolean,
): Promise<RewardSkillGate> {
  if (reward.identityGroupId === null) {
    const gate = {
      characterId: null,
      membershipCharacterId: null,
      matchMode: reward.skillPlanMatchMode,
      plans: [],
    } satisfies Omit<RewardSkillGate, "snapshot">;
    return { ...gate, snapshot: serializeRewardSkillGate(gate) };
  }

  const membershipQuery = tx
    .select({
      id: identityGroupMembershipsTable.id,
      characterId: identityGroupMembershipsTable.characterId,
    })
    .from(identityGroupMembershipsTable)
    .innerJoin(identityGroupsTable, rewardMembershipConditions(corporationId, userId))
    .where(activeRewardGroupConditions(corporationId, reward.identityGroupId));
  const membershipRows = lock ? await membershipQuery.for("share") : await membershipQuery;
  const membership = membershipRows[0];
  if (!membership) {
    throw new RewardSkillGateError(404, "Reward not found", "REWARD_NOT_FOUND");
  }

  const planQuery = tx
    .select({
      id: corporationSkillPlansTable.id,
      name: corporationSkillPlansTable.name,
      requiredSkills: corporationSkillPlansTable.requiredSkills,
      isActive: corporationSkillPlansTable.isActive,
      updatedAt: corporationSkillPlansTable.updatedAt,
    })
    .from(rewardSkillPlansTable)
    .innerJoin(corporationSkillPlansTable, and(
      eq(corporationSkillPlansTable.corporationId, rewardSkillPlansTable.corporationId),
      eq(corporationSkillPlansTable.id, rewardSkillPlansTable.skillPlanId),
    ))
    .where(and(
      eq(rewardSkillPlansTable.corporationId, corporationId),
      eq(rewardSkillPlansTable.rewardId, reward.id),
      eq(rewardSkillPlansTable.identityGroupId, reward.identityGroupId),
    ))
    .orderBy(asc(corporationSkillPlansTable.id));
  const plans = lock ? await planQuery.for("share") : await planQuery;

  let characterId = membership.characterId;
  if (plans.length > 0 && characterId === null) {
    const [fallbackCharacter] = await tx
      .select({ id: charactersTable.id })
      .from(charactersTable)
      .where(and(
        eq(charactersTable.userId, userId),
        eq(charactersTable.corporationId, corporationId),
        isNull(charactersTable.deletedAt),
      ))
      .orderBy(desc(charactersTable.isMain), asc(charactersTable.createdAt))
      .limit(1);
    characterId = fallbackCharacter?.id ?? null;
  }

  const gate = {
    characterId,
    membershipCharacterId: membership.characterId,
    matchMode: reward.skillPlanMatchMode,
    plans,
  } satisfies Omit<RewardSkillGate, "snapshot">;
  return { ...gate, snapshot: serializeRewardSkillGate(gate) };
}

export async function loadRewardSkillGate(
  corporationId: number,
  userId: number,
  reward: Pick<Reward, "id" | "identityGroupId" | "skillPlanMatchMode">,
): Promise<RewardSkillGate> {
  return db.transaction((tx) => readRewardSkillGate(tx, corporationId, userId, reward, false));
}

export async function assertRewardSkillGateUnchanged(
  tx: RewardTransaction,
  corporationId: number,
  userId: number,
  reward: Pick<Reward, "id" | "identityGroupId" | "skillPlanMatchMode">,
  expected: RewardSkillGate,
): Promise<void> {
  const current = await readRewardSkillGate(tx, corporationId, userId, reward, true);
  if (current.snapshot !== expected.snapshot) {
    throw new RewardSkillGateError(
      409,
      "兑换物品的技能要求或用于审核的角色刚刚发生变化，请重新检查技能资格",
      "REWARD_SKILL_REQUIREMENTS_CHANGED",
    );
  }
}

export async function auditRewardSkillGate(
  gate: RewardSkillGate,
  userId: number,
  corporationId: number,
): Promise<SkillAuditResult> {
  if (gate.plans.length === 0) {
    return { checkedAt: new Date().toISOString(), passed: true, skills: [], matchMode: gate.matchMode, plans: [] };
  }
  if (gate.plans.some((plan) => !plan.isActive)) {
    throw new RewardSkillGateError(
      409,
      "此兑换物品关联的技能方案已停用，请联系管理员更新兑换条件",
      "REWARD_SKILL_PLAN_INACTIVE",
    );
  }
  if (gate.characterId === null) {
    throw new RewardSkillGateError(
      409,
      "无法确认用于该行动组的角色，请先重新登录并绑定角色",
      "REWARD_SKILL_CHARACTER_UNAVAILABLE",
    );
  }
  return auditCharacterSkills({
    userId,
    corporationId,
    characterId: gate.characterId,
    requiredSkills: [],
    skillPlans: gate.plans.map((plan) => ({ id: plan.id, name: plan.name, requiredSkills: plan.requiredSkills })),
    skillPlanMatchMode: gate.matchMode,
  });
}

export async function getRewardSkillPlanSummaries(
  corporationId: number,
  rewardIds: number[],
): Promise<Map<number, RewardSkillPlanSummary[]>> {
  const result = new Map<number, RewardSkillPlanSummary[]>();
  if (rewardIds.length === 0) return result;
  const rows = await db
    .select({
      rewardId: rewardSkillPlansTable.rewardId,
      id: corporationSkillPlansTable.id,
      name: corporationSkillPlansTable.name,
      description: corporationSkillPlansTable.description,
      requiredSkills: corporationSkillPlansTable.requiredSkills,
      isActive: corporationSkillPlansTable.isActive,
    })
    .from(rewardSkillPlansTable)
    .innerJoin(corporationSkillPlansTable, and(
      eq(corporationSkillPlansTable.corporationId, rewardSkillPlansTable.corporationId),
      eq(corporationSkillPlansTable.id, rewardSkillPlansTable.skillPlanId),
    ))
    .where(and(
      eq(rewardSkillPlansTable.corporationId, corporationId),
      inArray(rewardSkillPlansTable.rewardId, rewardIds),
    ))
    .orderBy(asc(rewardSkillPlansTable.rewardId), asc(corporationSkillPlansTable.name));
  for (const row of rows) {
    const summary = {
      id: row.id,
      name: row.name,
      description: row.description,
      requiredSkillCount: row.requiredSkills.length,
      isActive: row.isActive,
    };
    result.set(row.rewardId, [...(result.get(row.rewardId) ?? []), summary]);
  }
  return result;
}
