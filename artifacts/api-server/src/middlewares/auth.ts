import { type Request, type Response, type NextFunction } from "express";
import { db, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getTenantContext } from "../lib/tenant";

declare module "express-session" {
  interface SessionData {
    userId: number;
    linkingUserId?: number;
    corporationId?: number;
    eveCharacterId?: number;
    eveOauthState?: string;
    eveOauthFlow?: "login" | "link_alt" | "economy" | "roster";
    economyLinkCorporationId?: number;
    rosterLinkCorporationId?: number;
  }
}

export const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;
export type Role = (typeof ROLE_LEVELS)[number];

export function hasRole(userRole: string, minRole: Role): boolean {
  return ROLE_LEVELS.indexOf(userRole as Role) >= ROLE_LEVELS.indexOf(minRole);
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireRole(minRole: Role) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.session.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    try {
      const tenant = await getTenantContext(req);
      if (!tenant || !hasRole(tenant.membership.role, minRole)) {
        res.status(403).json({ error: `Forbidden: ${minRole} role required` });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireRoleOrPermission(minRole: Role, permission: string) {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    if (!req.session.userId) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    try {
      const tenant = await getTenantContext(req);
      if (
        !tenant
        || (!hasRole(tenant.membership.role, minRole) && !tenant.permissions.includes(permission))
      ) {
        res.status(403).json({ error: "Forbidden" });
        return;
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}

export function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!(req as Request & { user?: { role: string } }).user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const user = (req as Request & { user?: { role: string } }).user;
  if (!user || !hasRole(user.role, "admin")) {
    res.status(403).json({ error: "Forbidden: admin only" });
    return;
  }
  next();
}
