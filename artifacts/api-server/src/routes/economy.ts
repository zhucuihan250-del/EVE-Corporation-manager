import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth";
import { generateOauthState, getCorporationWalletAuthorizationUrl } from "../lib/eve-sso";
import { analyzeEconomy, economySummary, latestEconomyAnalysis, syncCorporationWallet } from "../lib/corporation-economy";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();

router.use("/economy", requireAuth, requireTenant, requireModule("economy"));

function getCallbackUrl(req: Request): string {
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? req.protocol ?? "https";
  return `${proto}://${host}/api/auth/eve/callback`;
}

function requireEconomy(req: Request, res: Response, manage = false): boolean {
  const permission = manage ? "economy.manage" : "economy.view";
  if (!req.tenant || !hasPermission(req.tenant, permission)) {
    res.status(403).json({ error: "总监权限人员才能访问军团经济" });
    return false;
  }
  return true;
}

router.get("/economy", async (req: Request, res: Response): Promise<void> => {
  if (!requireEconomy(req, res)) return;
  const [summary, analysis] = await Promise.all([
    economySummary(req.tenant!.corporation.id),
    latestEconomyAnalysis(req.tenant!.corporation.id),
  ]);
  res.json({ ...summary, analysis });
});

router.get("/economy/connect", async (req: Request, res: Response): Promise<void> => {
  if (!requireEconomy(req, res, true)) return;
  const state = generateOauthState();
  req.session.economyLinkCorporationId = req.tenant!.corporation.id;
  req.session.rosterLinkCorporationId = undefined;
  req.session.structuresLinkCorporationId = undefined;
  req.session.linkingUserId = undefined;
  req.session.eveOauthState = state;
  req.session.eveOauthFlow = "economy";
  req.session.save((error) => {
    if (error) {
      res.status(500).json({ error: "Unable to start wallet authorization" });
      return;
    }
    res.redirect(getCorporationWalletAuthorizationUrl(getCallbackUrl(req), state));
  });
});

router.post("/economy/sync", async (req: Request, res: Response): Promise<void> => {
  if (!requireEconomy(req, res, true)) return;
  try {
    const result = await syncCorporationWallet(req.tenant!.corporation.id);
    res.json(result);
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : "Wallet sync failed" });
  }
});

router.post("/economy/analyze", async (req: Request, res: Response): Promise<void> => {
  if (!requireEconomy(req, res, true)) return;
  const analysis = await analyzeEconomy(req.tenant!.corporation.id, req.tenant!.user.id);
  res.json(analysis);
});

export default router;
