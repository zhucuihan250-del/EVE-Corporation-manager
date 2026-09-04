import {
  corporationSkillPlansTable,
  identityGroupMembershipsTable,
  identityGroupSkillPlansTable,
  identityGroupsTable,
  rewardSkillPlansTable,
  rewardsTable,
} from "@workspace/db/schema";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { db } from "@workspace/db";

type RewardTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class RewardScopeError extends Error {}

export async function lockRewardMembership(tx: RewardTransaction, corporationId: number, userId: number, groupId: number) {
  const [membership] = await tx.select({ id: identityGroupMembershipsTable.id })
    .from(identityGroupMembershipsTable)
    .innerJoin(identityGroupsTable, rewardMembershipConditions(corporationId, userId))
    .where(activeRewardGroupConditions(corporationId, groupId))
    .for("share");
  return Boolean(membership);
}

export async function validateRewardSkillPlanTargets(
  tx: RewardTransaction,
  corporationId: number,
  groupId: number | null,
  skillPlanIds: number[],
): Promise<void> {
  if (skillPlanIds.length === 0) return;
  if (groupId === null) {
    throw new RewardScopeError("只有行动组专属兑换物品可以设置技能方案");
  }
  const rows = await tx
    .select({ id: identityGroupSkillPlansTable.skillPlanId })
    .from(identityGroupSkillPlansTable)
    .innerJoin(identityGroupsTable, and(
      eq(identityGroupsTable.corporationId, identityGroupSkillPlansTable.corporationId),
      eq(identityGroupsTable.id, identityGroupSkillPlansTable.groupId),
      eq(identityGroupsTable.category, "combat"),
      eq(identityGroupsTable.isActive, true),
    ))
    .innerJoin(corporationSkillPlansTable, and(
      eq(corporationSkillPlansTable.corporationId, identityGroupSkillPlansTable.corporationId),
      eq(corporationSkillPlansTable.id, identityGroupSkillPlansTable.skillPlanId),
      eq(corporationSkillPlansTable.isActive, true),
    ))
    .where(and(
      eq(identityGroupSkillPlansTable.corporationId, corporationId),
      eq(identityGroupSkillPlansTable.groupId, groupId),
      inArray(identityGroupSkillPlansTable.skillPlanId, skillPlanIds),
    ))
    .for("share");
  if (rows.length !== skillPlanIds.length) {
    throw new RewardScopeError("技能要求只能选择该行动组内已启用的技能方案");
  }
}

export async function replaceRewardSkillPlans(
  tx: RewardTransaction,
  corporationId: number,
  rewardId: number,
  groupId: number | null,
  skillPlanIds: number[],
): Promise<void> {
  await tx.delete(rewardSkillPlansTable).where(and(
    eq(rewardSkillPlansTable.corporationId, corporationId),
    eq(rewardSkillPlansTable.rewardId, rewardId),
  ));
  if (groupId !== null && skillPlanIds.length > 0) {
    await tx.insert(rewardSkillPlansTable).values(skillPlanIds.map((skillPlanId) => ({
      corporationId,
      rewardId,
      identityGroupId: groupId,
      skillPlanId,
    })));
  }
}

export async function validateRewardGroupTarget(
  tx: RewardTransaction,
  corporationId: number,
  groupId: number | null | undefined,
  identityEnabled: boolean,
): Promise<void> {
  if (groupId == null) return;
  if (identityEnabled && Number.isInteger(groupId) && groupId > 0) {
    const [group] = await tx.select({ id: identityGroupsTable.id })
      .from(identityGroupsTable)
      .where(activeRewardGroupConditions(corporationId, groupId))
      .for("share");
    if (group) return;
  }
  throw new RewardScopeError("请选择本军团内已启用的行动组；管理身份组不能设置专属兑换物品");
}

/** Member visibility is also checked when redeeming; an admin role never grants redemption eligibility. */
export function rewardMemberVisibility(corporationId: number, userId: number, identityEnabled: boolean) {
  return and(
    eq(rewardsTable.corporationId, corporationId),
    identityEnabled ? or(
      isNull(rewardsTable.identityGroupId),
      sql`EXISTS (
        SELECT 1 FROM "identity_group_memberships" AS "reward_membership"
        INNER JOIN "identity_groups" AS "reward_group"
          ON "reward_group"."id" = "reward_membership"."group_id"
          AND "reward_group"."corporation_id" = "reward_membership"."corporation_id"
        WHERE "reward_membership"."corporation_id" = ${corporationId}
          AND "reward_membership"."user_id" = ${userId}
          AND "reward_group"."id" = ${rewardsTable.identityGroupId}
          AND "reward_group"."category" = 'combat'
          AND "reward_group"."is_active" = true
      )`,
    ) : isNull(rewardsTable.identityGroupId),
  );
}

export function activeRewardGroupConditions(corporationId: number, groupId: number) {
  return and(
    eq(identityGroupsTable.id, groupId),
    eq(identityGroupsTable.corporationId, corporationId),
    eq(identityGroupsTable.category, "combat"),
    eq(identityGroupsTable.isActive, true),
  );
}

export function rewardMembershipConditions(corporationId: number, userId: number) {
  return and(
    eq(identityGroupMembershipsTable.groupId, identityGroupsTable.id),
    eq(identityGroupMembershipsTable.corporationId, corporationId),
    eq(identityGroupMembershipsTable.userId, userId),
  );
}
