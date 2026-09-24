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
import { and, eq, isNull } from "drizzle-orm";
import type { Role } from "../middlewares/auth";
import { getSiteCorporation, requireSiteCorporation } from "./single-corporation";
import { siteSessionAllowsActor } from "./single-corporation-rules";

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
  const site = await requireSiteCorporation();
  if (corporationId !== site.id) throw new Error("This corporation cannot use this website");
  // Login may refresh a verified name, but never rewrites administrator settings.
  if (corporationName && corporationName !== site.name) {
    const [updated] = await db.update(corporationsTable).set({ name: corporationName })
      .where(eq(corporationsTable.id, site.id)).returning();
    return updated;
  }
  return site;
}

export async function ensureCorporationMembership(
  userId: number,
  corporationId: number,
  _preferredRole: Role = "member",
): Promise<typeof corporationMembershipsTable.$inferSelect> {
  const site = await requireSiteCorporation();
  if (corporationId !== site.id) throw new Error("This corporation cannot use this website");
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(corporationMembershipsTable).where(and(
      eq(corporationMembershipsTable.corporationId, site.id),
      eq(corporationMembershipsTable.userId, userId),
    ));
    if (existing) return existing;
    // Provisioning never imports a legacy global/foreign-corporation role and
    // never turns the first visitor into an administrator.
    await tx.insert(corporationMembershipsTable)
      .values({ corporationId: site.id, userId, role: "member" })
      .onConflictDoNothing();
    const [created] = await tx.select().from(corporationMembershipsTable).where(and(
      eq(corporationMembershipsTable.corporationId, site.id),
      eq(corporationMembershipsTable.userId, userId),
    ));
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

// Cache only contexts validated here, and only while the request's identity is
// unchanged. Merely assigning req.tenant or switching a session must not bypass
// the site/actor eligibility checks at subsequent permission middleware.
const validatedTenantContexts = new WeakMap<Request, {
  tenant: TenantContext;
  userId: number;
  corporationId: number | undefined;
  eveCharacterId: number | undefined;
  configuredCorporationId: string | undefined;
}>();

export async function getTenantContext(req: Request): Promise<TenantContext | null> {
  const cached = validatedTenantContexts.get(req);
  if (cached
    && req.tenant === cached.tenant
    && req.session.userId === cached.userId
    && req.session.corporationId === cached.corporationId
    && req.session.eveCharacterId === cached.eveCharacterId
    && process.env.PRIMARY_CORPORATION_ID === cached.configuredCorporationId
  ) return cached.tenant;
  validatedTenantContexts.delete(req);
  req.tenant = undefined;
  if (!req.session.userId) return null;

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId));
  if (!user) return null;

  const corporation = await getSiteCorporation();
  if (!corporation) return null;
  const corporationId = corporation.id;
  if (req.session.corporationId !== undefined && req.session.corporationId !== corporationId) return null;

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
  const sessionCharacterId = req.session.eveCharacterId ?? user.eveCharacterId;
  if (!sessionCharacterId) return null;
  actorConditions.push(eq(charactersTable.eveCharacterId, sessionCharacterId));
  const [actorCharacter] = await db
    .select()
    .from(charactersTable)
    .where(and(...actorConditions))
    .limit(1);
  if (!siteSessionAllowsActor({
    siteCorporationId: corporationId,
    sessionCorporationId: req.session.corporationId,
    sessionCharacterId,
    userId: user.id,
    actor: actorCharacter ?? null,
  })) return null;

  const permissions = await loadPermissions(user.id, corporationId);
  if (membership.role === "controller") {
    permissions.push(
      "economy.view",
      "economy.manage",
      "reimbursement.window.manage",
    );
  }
  const scopedPermissions = [...new Set(permissions)];
  req.tenant = { user, corporation, membership, actorCharacter: actorCharacter ?? null, permissions: scopedPermissions };
  validatedTenantContexts.set(req, {
    tenant: req.tenant,
    userId: req.session.userId,
    corporationId: req.session.corporationId,
    eveCharacterId: req.session.eveCharacterId,
    configuredCorporationId: process.env.PRIMARY_CORPORATION_ID,
  });
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
  | "diplomacy"
  | "courier"
  | "structures";

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
