import { identityGroupMembershipsTable, identityGroupsTable, rewardsTable } from "@workspace/db/schema";
import { and, eq, isNull, or, sql } from "drizzle-orm";
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
