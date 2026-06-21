import { type Request, type Response, type NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    userId: number;
    linkingUserId?: number;
  }
}

export const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;
export type Role = typeof ROLE_LEVELS[number];

export function hasRole(userRole: string, minRole: Role): boolean {
  return ROLE_LEVELS.indexOf(userRole as Role) >= ROLE_LEVELS.indexOf(minRole);
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.session.userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
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
