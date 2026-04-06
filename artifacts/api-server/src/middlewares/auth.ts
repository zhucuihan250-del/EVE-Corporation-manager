import { type Request, type Response, type NextFunction } from "express";

declare module "express-session" {
  interface SessionData {
    userId: number;
  }
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
  if (!user || user.role !== "admin") {
    res.status(403).json({ error: "Forbidden: admin only" });
    return;
  }
  next();
}
