import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { BuybackError } from "./buyback-calculation";
import { BuybackRequestLimiter, type BuybackActor, type createBuybackService } from "./buyback-service";
import type { BuybackCatalogTarget } from "./buyback-catalog";

export type BuybackRouterDependencies = {
  service: ReturnType<typeof createBuybackService>;
  requireAuth: RequestHandler;
  requireTenant: RequestHandler;
  searchCatalog(query: string, kind: "type" | "category"): Promise<BuybackCatalogTarget[]>;
};

/** Runtime wiring supplies the existing authentication middleware. Tests inject
 * an in-memory database and explicit fixture actors, never a production login. */
export function createBuybackRouter(dependencies: BuybackRouterDependencies) {
  const router = Router();
  const service = dependencies.service;
  const limiter = new BuybackRequestLimiter();
  const actor = (req: Request): BuybackActor => ({
    corporationId: req.tenant!.corporation.id, userId: req.tenant!.user.id,
    userName: req.tenant!.user.eveCharacterName ?? `用户 ${req.tenant!.user.id}`, role: req.tenant!.membership.role,
  });
  router.use("/buyback", dependencies.requireAuth, dependencies.requireTenant);
  router.use("/admin/buyback", dependencies.requireAuth, dependencies.requireTenant, (req: Request, res: Response, next: NextFunction) => {
    if (!["admin", "controller"].includes(req.tenant!.membership.role)) {
      res.status(403).json({ error: "只有管理员或总监可以管理回收规则。", code: "BUYBACK_ADMIN_REQUIRED" });
      return;
    }
    next();
  });
  const route = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof BuybackError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      if ((error as { code?: string })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505") {
        res.status(409).json({ error: "该物品或类别已有规则，请编辑现有规则。", code: "BUYBACK_RULE_EXISTS" }); return;
      }
      next(error);
    }
  };
  const ruleId = (req: Request) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id <= 0 || !/^\d+$/.test(String(req.params.id))) throw new BuybackError(400, "INVALID_BUYBACK_RULE_ID", "规则编号无效。");
    return id;
  };
  router.get("/buyback/settings", route(async (req, res) => { res.json(await service.getConfiguration(actor(req).corporationId)); }));
  router.get("/buyback/catalog", route(async (req, res) => {
    const query = typeof req.query.query === "string" ? req.query.query.trim() : "";
    const kind = req.query.kind;
    if (!["type", "category"].includes(String(kind)) || query.length > 100) throw new BuybackError(400, "INVALID_BUYBACK_SEARCH", "搜索条件无效。");
    limiter.take(`catalog:${actor(req).userId}`, 120);
    res.json({ items: await dependencies.searchCatalog(query, kind as "type" | "category") });
  }));
  router.get("/buyback/quotes", route(async (req, res) => { res.json({ quotes: await service.listQuotes(actor(req)) }); }));
  router.get("/admin/buyback", route(async (req, res) => {
    const current = actor(req);
    const configuration = await service.getConfiguration(current.corporationId);
    res.json({ ...configuration, quotes: await service.listQuotes(current, true) });
  }));
  router.put("/admin/buyback/settings", route(async (req, res) => { res.json(await service.saveSettings(actor(req), req.body)); }));
  router.post("/admin/buyback/rules", route(async (req, res) => { res.status(201).json(await service.writeRule(actor(req), req.body)); }));
  router.put("/admin/buyback/rules/:id", route(async (req, res) => { res.json(await service.writeRule(actor(req), req.body, ruleId(req))); }));
  router.delete("/admin/buyback/rules/:id", route(async (req, res) => { res.json(await service.deleteRule(actor(req), ruleId(req), req.body?.version)); }));
  router.post("/buyback/quotes", route(async (req, res) => { res.status(201).json(await service.createQuote(actor(req), req.body)); }));
  return router;
}
