import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth, hasRole } from "../middlewares/auth";
import {
  generateOauthState,
  getCorporationStructuresAuthorizationUrl,
} from "../lib/eve-sso";
import {
  corporationStructuresDashboard,
  syncCorporationStructures,
} from "../lib/corporation-structures";
import { requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();
const AUTO_SYNC_AFTER_MS = 55 * 60 * 1_000;

router.use("/structures", requireAuth, requireTenant, requireModule("structures"));

function getCallbackUrl(req: Request): string {
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim()
    ?? req.get("host")
    ?? "localhost";
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim()
    ?? req.protocol
    ?? "https";
  return `${proto}://${host}/api/auth/eve/callback`;
}

function requireStructuresAdmin(req: Request, res: Response): boolean {
  if (!req.tenant || !hasRole(req.tenant.membership.role, "admin")) {
    res.status(403).json({ error: "仅总监和管理员可以查看军团建筑" });
    return false;
  }
  return true;
}

router.get("/structures", async (req: Request, res: Response): Promise<void> => {
  if (!requireStructuresAdmin(req, res)) return;
  const corporationId = req.tenant!.corporation.id;
  let dashboard = await corporationStructuresDashboard(corporationId);
  const lastSyncedAt = dashboard.connection?.lastSyncedAt?.getTime() ?? 0;

  if (dashboard.connection && Date.now() - lastSyncedAt >= AUTO_SYNC_AFTER_MS) {
    try {
      await syncCorporationStructures(corporationId);
    } catch {
      // The synchronization error is stored on the corporation-scoped connection.
      // Returning the last snapshot lets directors see both stale data and the exact error.
    }
    dashboard = await corporationStructuresDashboard(corporationId);
  }

  res.json(dashboard);
});

router.get("/structures/connect", (req: Request, res: Response): void => {
  if (!requireStructuresAdmin(req, res)) return;
  const state = generateOauthState();
  req.session.structuresLinkCorporationId = req.tenant!.corporation.id;
  req.session.economyLinkCorporationId = undefined;
  req.session.rosterLinkCorporationId = undefined;
  req.session.linkingUserId = undefined;
  req.session.eveOauthState = state;
  req.session.eveOauthFlow = "structures";
  req.session.save((error) => {
    if (error) {
      res.status(500).json({ error: "无法启动军团建筑授权" });
      return;
    }
    res.redirect(getCorporationStructuresAuthorizationUrl(getCallbackUrl(req), state));
  });
});

router.post("/structures/sync", async (req: Request, res: Response): Promise<void> => {
  if (!requireStructuresAdmin(req, res)) return;
  try {
    await syncCorporationStructures(req.tenant!.corporation.id);
    res.json(await corporationStructuresDashboard(req.tenant!.corporation.id));
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : "军团建筑同步失败",
    });
  }
});

export default router;
