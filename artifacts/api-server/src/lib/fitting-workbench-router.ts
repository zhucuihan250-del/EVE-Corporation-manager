import { Router, type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { FittingCategory, FittingLanguage, FittingSlot } from "./fitting-data";
import { fittingId, FittingWorkbenchError, type FittingActor } from "./fitting-workbench-errors";
import type { createFittingWorkbenchService } from "./fitting-workbench-service";

type CatalogOptions = { query?: string; category?: FittingCategory | "all"; slot?: FittingSlot | "all"; language: FittingLanguage; limit?: number };
type CatalogResult = { sdeBuildNumber: number | null; generatedAt: string; items: unknown[] };

/** Mount after the API router on /api/fitting, also covering errors emitted by
 * the JSON parser before authentication. Never serialize upstream/SQL bodies. */
export const fittingWorkbenchErrorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const details = error && typeof error === "object" ? error as { status?: number; type?: string; code?: string; name?: string } : {};
  if (details.status === 413 || details.type === "entity.too.large") {
    res.status(413).json({ error: "配装内容过大，请缩减配置或分批导入。", code: "FITTING_PAYLOAD_TOO_LARGE" }); return;
  }
  if (details.status === 400 && error instanceof URIError) {
    res.status(400).json({ error: "配装请求路径无效。", code: "FITTING_INVALID_INPUT" }); return;
  }
  if (details.status === 400 && ["entity.parse.failed", "request.aborted", "request.size.invalid"].includes(details.type ?? "")) {
    res.status(400).json({ error: "配装请求不是有效的 JSON 对象。", code: "FITTING_INVALID_INPUT" }); return;
  }
  req.log?.error({ errorCode: typeof details.code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(details.code) ? details.code : "UNEXPECTED" }, "Fitting request failed");
  res.status(500).json({ error: "配装服务暂时不可用，请稍后重试。", code: "FITTING_UNAVAILABLE" });
};

export function createFittingWorkbenchRouter(dependencies: {
  service: ReturnType<typeof createFittingWorkbenchService>;
  requireAuth: RequestHandler;
  requireTenant: RequestHandler;
  requireFleet: RequestHandler;
  searchCatalog(options: CatalogOptions): CatalogResult | Promise<CatalogResult>;
  getCatalogItem(typeId: number, language: FittingLanguage): unknown;
  isEngineInputError(error: unknown): error is Error & { status: number; code: string };
}) {
  const router = Router(), service = dependencies.service;
  const actor = (req: Request): FittingActor => ({ corporationId: req.tenant!.corporation.id, userId: req.tenant!.user.id, userName: req.tenant!.user.eveCharacterName ?? `成员 ${req.tenant!.user.id}`, role: req.tenant!.membership.role, permissions: req.tenant!.permissions });
  const windows = new Map<string, { start: number; count: number }>();
  const limit: RequestHandler = (req, res, next) => {
    const now = Date.now(), current = actor(req);
    const kind = req.path.endsWith("/skills") ? "skills" : req.path.endsWith("/workbench") || req.path.endsWith("/simulate") ? "simulation" : req.method === "GET" ? "read" : "write";
    const key = `${current.corporationId}:${current.userId}:${kind}`, max = kind === "skills" ? 30 : kind === "write" ? 60 : kind === "simulation" ? 240 : 180;
    for (const [windowKey, entry] of windows) if (now - entry.start >= 60_000) windows.delete(windowKey);
    const previous = windows.get(key);
    if ((previous?.count ?? 0) >= max || (!previous && windows.size >= 5000)) {
      res.setHeader("Retry-After", "60"); res.status(429).json({ error: "操作过于频繁，请稍后重试。", code: "FITTING_RATE_LIMIT" }); return;
    }
    windows.set(key, { start: previous?.start ?? now, count: (previous?.count ?? 0) + 1 });
    if (req.method !== "GET" && Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8") > 96 * 1024) {
      res.status(413).json({ error: "配装内容过大，请缩减配置或分批导入。", code: "FITTING_PAYLOAD_TOO_LARGE" }); return;
    }
    next();
  };
  router.use("/fitting", dependencies.requireAuth, dependencies.requireTenant, dependencies.requireFleet, limit);
  const route = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof FittingWorkbenchError || dependencies.isEngineInputError(error)) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      fittingWorkbenchErrorHandler(error, req, res, next);
    }
  };
  const categories = new Set(["all", "ship", "module", "charge", "drone", "subsystem", "fighter", "implant", "booster", "skill", "cargo"]);
  const slots = new Set(["all", "high", "medium", "low", "rig", "subsystem", "charge", "drone", "fighter", "implant", "booster", "service", "other"]);
  router.get("/fitting/catalog", route(async (req, res) => {
    const lng = req.query.language === "en" ? "en" : "zh";
    if (req.query.q !== undefined && (typeof req.query.q !== "string" || req.query.q.length > 100)) throw new FittingWorkbenchError(400, "FITTING_INVALID_SEARCH", "搜索词最多 100 字。");
    if (req.query.typeIds !== undefined) {
      if (typeof req.query.typeIds !== "string" || req.query.typeIds.length > 1200) throw new FittingWorkbenchError(400, "FITTING_INVALID_TYPE_IDS", "物品编号列表无效。");
      const parts = req.query.typeIds.split(",");
      if (parts.length > 100 || parts.some(part => !/^\d+$/.test(part))) throw new FittingWorkbenchError(400, "FITTING_INVALID_TYPE_IDS", "一次最多查询 100 个物品编号。");
      const ids = [...new Set(parts.map(fittingId))], items: unknown[] = [], missingTypeIds: number[] = [];
      for (const id of ids) { const item = dependencies.getCatalogItem(id, lng); if (item) items.push(item); else missingTypeIds.push(id); }
      const metadata = await dependencies.searchCatalog({ query: "", category: "ship", language: lng, limit: 1 });
      res.json({ ...metadata, items, missingTypeIds }); return;
    }
    const category = categories.has(String(req.query.category)) ? req.query.category as FittingCategory | "all" : "all";
    const slot = slots.has(String(req.query.slot)) ? req.query.slot as FittingSlot | "all" : "all";
    const requestedLimit = typeof req.query.limit === "string" ? Number(req.query.limit) : 50;
    res.json(await dependencies.searchCatalog({ query: typeof req.query.q === "string" ? req.query.q : "", category, slot, language: lng, limit: Number.isFinite(requestedLimit) ? requestedLimit : 50 }));
  }));
  router.post("/fitting/simulate", route(async (req, res) => {
    const simulation = await service.simulate(actor(req), req.body, true);
    // Preserve the original discriminator accepted by older generated clients.
    res.json({ ...simulation, precision: "approximate", calculationPrecision: simulation.calculationPrecision });
  }));
  router.post("/fitting/workbench", route(async (req, res) => { res.json(await service.simulate(actor(req), req.body)); }));
  router.post("/fitting/import", route(async (req, res) => { res.json(await service.importFit(req.body)); }));
  router.post("/fitting/export", route(async (req, res) => { res.json(await service.exportFit(req.body)); }));
  router.get("/fitting/saved", route(async (req, res) => { res.json(await service.listSaved(actor(req), { cursor: req.query.cursor, limit: req.query.limit, visibility: req.query.visibility })); }));
  router.get("/fitting/saved/:id", route(async (req, res) => { res.json(await service.getSaved(actor(req), fittingId(req.params.id))); }));
  router.post("/fitting/saved", route(async (req, res) => { res.status(201).json(await service.createSaved(actor(req), req.body)); }));
  router.put("/fitting/saved/:id", route(async (req, res) => { res.json(await service.updateSaved(actor(req), fittingId(req.params.id), req.body)); }));
  router.delete("/fitting/saved/:id", route(async (req, res) => { res.json(await service.deleteSaved(actor(req), fittingId(req.params.id), req.body)); }));
  router.get("/fitting/characters", route(async (req, res) => { res.json(await service.listCharacters(actor(req))); }));
  router.get("/fitting/characters/:id/skills", route(async (req, res) => { res.json(await service.getSkills(actor(req), fittingId(req.params.id))); }));
  return router;
}
