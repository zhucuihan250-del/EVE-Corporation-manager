import type { NextFunction, Request, Response } from "express";
import {
  corporationMembershipsTable,
  corporationsTable,
  charactersTable,
  db,
  identityGroupMembershipsTable,
  identityGroupsTable,
  usersTable,
} from "@workspace/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Role } from "../middlewares/auth";

export type TenantContext = {
  user: typeof usersTable.$inferSelect;
  corporation: typeof corporationsTable.$inferSelect;
  membership: typeof corporationMembershipsTable.$inferSelect;
  actorCharacter: typeof charactersTable.$inferSelect | null;
  permissions: string[];
};

declare global {
  namespace Express {
    interface Request {
      tenant?: TenantContext;
    }
  }
}

export async function ensureCorporation(
  corporationId: number,
  corporationName: string,
): Promise<typeof corporationsTable.$inferSelect> {
  if (!Number.isInteger(corporationId) || corporationId <= 0) {
    throw new Error("A verified EVE corporation is required");
  }

  return db.transaction(async (tx) => {
    const configuredPrimaryId = Number(process.env.PRIMARY_CORPORATION_ID);
    const hasConfiguredPrimary = Number.isInteger(configuredPrimaryId) && configuredPrimaryId > 0;
    const [existing] = await tx
      .select()
      .from(corporationsTable)
      .where(eq(corporationsTable.id, corporationId));
    if (existing) {
      if (hasConfiguredPrimary && corporationId === configuredPrimaryId && !existing.isPrimary) {
        await tx.update(corporationsTable).set({
          isPrimary: false,
          papEnabled: false,
          identityEnabled: false,
          economyEnabled: false,
          fleetEnabled: false,
          reimbursementEnabled: true,
          diplomacyEnabled: true,
        }).where(eq(corporationsTable.isPrimary, true));
        const [promoted] = await tx.update(corporationsTable).set({
          isPrimary: true,
          papEnabled: true,
          identityEnabled: true,
          economyEnabled: true,
          fleetEnabled: true,
          reimbursementEnabled: true,
          diplomacyEnabled: true,
        }).where(eq(corporationsTable.id, corporationId)).returning();
        return promoted;
      }
      if (corporationName && existing.name !== corporationName) {
        const [updated] = await tx
          .update(corporationsTable)
          .set({ name: corporationName })
          .where(eq(corporationsTable.id, corporationId))
          .returning();
        return updated;
      }
      return existing;
    }

    const [primary] = await tx
      .select({ id: corporationsTable.id })
      .from(corporationsTable)
      .where(eq(corporationsTable.isPrimary, true))
      .limit(1);
    const isPrimary = hasConfiguredPrimary
      ? corporationId === configuredPrimaryId
      : !primary;
    if (isPrimary && primary) {
      await tx.update(corporationsTable).set({
        isPrimary: false,
        papEnabled: false,
        identityEnabled: false,
        economyEnabled: false,
        fleetEnabled: false,
        reimbursementEnabled: true,
        diplomacyEnabled: true,
      }).where(eq(corporationsTable.isPrimary, true));
    }
    const [created] = await tx
      .insert(corporationsTable)
      .values({
        id: corporationId,
        name: corporationName || `Corporation ${corporationId}`,
        isPrimary,
        papEnabled: isPrimary,
        identityEnabled: isPrimary,
        economyEnabled: isPrimary,
        fleetEnabled: isPrimary,
        reimbursementEnabled: true,
        diplomacyEnabled: true,
      })
      .returning();
    return created;
  });
}

export async function ensureCorporationMembership(
  userId: number,
  corporationId: number,
  preferredRole: Role = "member",
): Promise<typeof corporationMembershipsTable.$inferSelect> {
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(corporationMembershipsTable)
      .where(
        and(
          eq(corporationMembershipsTable.corporationId, corporationId),
          eq(corporationMembershipsTable.userId, userId),
        ),
      );
    if (existing) return existing;

    const [{ count }] = await tx
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(corporationMembershipsTable)
      .where(eq(corporationMembershipsTable.corporationId, corporationId));
    const role: Role = count === 0 ? "admin" : preferredRole;
    const [created] = await tx
      .insert(corporationMembershipsTable)
      .values({ corporationId, userId, role })
      .returning();
    return created;
  });
}

async function loadPermissions(
  userId: number,
  corporationId: number,
): Promise<string[]> {
  const rows = await db
    .select({ permissions: identityGroupsTable.permissions })
    .from(identityGroupMembershipsTable)
    .innerJoin(
      identityGroupsTable,
      and(
        eq(identityGroupsTable.id, identityGroupMembershipsTable.groupId),
        eq(identityGroupsTable.corporationId, corporationId),
      ),
    )
    .where(
      and(
        eq(identityGroupMembershipsTable.corporationId, corporationId),
        eq(identityGroupMembershipsTable.userId, userId),
        eq(identityGroupsTable.isActive, true),
      ),
    );
  return [...new Set(rows.flatMap((row) => row.permissions))];
}

export async function getTenantContext(req: Request): Promise<TenantContext | null> {
  if (req.tenant) return req.tenant;
  if (!req.session.userId) return null;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId));
  if (!user) return null;

  const corporationId = req.session.corporationId ?? user.corporationId;
  if (!corporationId) return null;

  const [corporation] = await db
    .select()
    .from(corporationsTable)
    .where(
      and(
        eq(corporationsTable.id, corporationId),
        eq(corporationsTable.isActive, true),
      ),
    );
  if (!corporation) return null;

  const [membership] = await db
    .select()
    .from(corporationMembershipsTable)
    .where(
      and(
        eq(corporationMembershipsTable.corporationId, corporationId),
        eq(corporationMembershipsTable.userId, user.id),
      ),
    );
  if (!membership) return null;

  const actorConditions = [
    eq(charactersTable.userId, user.id),
    eq(charactersTable.corporationId, corporationId),
    isNull(charactersTable.deletedAt),
  ];
  if (req.session.eveCharacterId) {
    actorConditions.push(eq(charactersTable.eveCharacterId, req.session.eveCharacterId));
  }
  let [actorCharacter] = await db
    .select()
    .from(charactersTable)
    .where(and(...actorConditions))
    .limit(1);
  if (!actorCharacter && req.session.eveCharacterId) {
    [actorCharacter] = await db
      .select()
      .from(charactersTable)
      .where(and(
        eq(charactersTable.userId, user.id),
        eq(charactersTable.corporationId, corporationId),
        isNull(charactersTable.deletedAt),
      ))
      .limit(1);
  }

  const permissions = await loadPermissions(user.id, corporationId);
  if (membership.role === "controller") {
    permissions.push("economy.view", "economy.manage");
  }
  const scopedPermissions = [...new Set(permissions)];
  req.tenant = { user, corporation, membership, actorCharacter: actorCharacter ?? null, permissions: scopedPermissions };
  return req.tenant;
}

export async function requireTenant(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const tenant = await getTenantContext(req);
    if (!tenant) {
      res.status(403).json({ error: "Corporation access is not available" });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
}

export type CorporationModule =
  | "pap"
  | "identity"
  | "economy"
  | "fleet"
  | "reimbursement"
  | "diplomacy";

export function moduleEnabled(
  tenant: TenantContext,
  module: CorporationModule,
): boolean {
  const key = `${module}Enabled` as const;
  return Boolean(tenant.corporation[key]);
}

export function requireModule(module: CorporationModule) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenant = await getTenantContext(req);
      if (!tenant || !moduleEnabled(tenant, module)) {
        res.status(404).json({ error: "Module not available" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function hasPermission(tenant: TenantContext, permission: string): boolean {
  return tenant.permissions.includes(permission);
}

export function requirePermission(permission: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const tenant = await getTenantContext(req);
      if (!tenant || !hasPermission(tenant, permission)) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
