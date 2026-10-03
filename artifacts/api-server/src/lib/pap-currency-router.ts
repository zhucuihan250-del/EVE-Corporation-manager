import { Router, type Request, type RequestHandler, type Response, type NextFunction } from "express";
import type { createPapCurrencyService, PapCurrencyActor } from "./pap-currency-service";
import { PapCurrencyError } from "./pap-currency-math";

export function createPapCurrencyRouter(dependencies: {
  service: ReturnType<typeof createPapCurrencyService>;
  requireAuth: RequestHandler;
  requireTenant: RequestHandler;
  requirePap: RequestHandler;
}) {
  const router = Router(), service = dependencies.service;
  const actor = (req: Request): PapCurrencyActor => ({ corporationId: req.tenant!.corporation.id, userId: req.tenant!.user.id, userName: req.tenant!.user.eveCharacterName ?? `成员 ${req.tenant!.user.id}`, role: req.tenant!.membership.role });
  const windows = new Map<string, { start: number; count: number }>();
  const limit: RequestHandler = (req, res, next) => {
    const now = Date.now(), key = `${actor(req).userId}:${req.method === "GET" ? "read" : "write"}`;
    for (const [key, value] of windows) if (now - value.start > 60_000) windows.delete(key);
    const previous = windows.get(key), count = previous?.count ?? 0;
    if (count >= (req.method === "GET" ? 180 : 60) || (!previous && windows.size >= 5000)) { res.status(429).json({ error: "操作过于频繁，请稍后重试。", code: "PAP_RATE_LIMIT" }); return; }
    windows.set(key, { start: previous?.start ?? now, count: count + 1 }); next();
  };
  for (const path of ["/pap-currencies", "/pap-wallet", "/admin/pap-currencies"]) router.use(path, dependencies.requireAuth, dependencies.requireTenant, dependencies.requirePap, limit);
  router.use("/admin/pap-currencies", (req, res, next) => {
    if (!["admin", "controller"].includes(actor(req).role)) { res.status(403).json({ error: "只有管理员或总监可以管理 PAP 种类。", code: "PAP_ADMIN_REQUIRED" }); return; }
    next();
  });
  const route = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => {
    try { await handler(req, res); }
    catch (error) {
      if (error instanceof PapCurrencyError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      if ((error as { code?: string })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505") { res.status(409).json({ error: "名称或请求已存在，请刷新后重试。", code: "PAP_REQUEST_CONFLICT" }); return; }
      next(error);
    }
  };
  router.get("/pap-currencies", route(async (req, res) => { res.json({ currencies: await service.listCurrencies(actor(req).corporationId) }); }));
  router.get("/pap-wallet", route(async (req, res) => { res.json(await service.getWallet(actor(req))); }));
  router.post("/pap-wallet/preview", route(async (req, res) => { res.json(await service.preview(actor(req), req.body)); }));
  router.post("/pap-wallet/convert", route(async (req, res) => { res.json(await service.convert(actor(req), req.body)); }));
  router.get("/admin/pap-currencies", route(async (req, res) => { res.json({ currencies: await service.listCurrencies(actor(req).corporationId), entries: await service.listEntries(actor(req), true) }); }));
  router.get("/admin/pap-currencies/members", route(async (req, res) => { res.json(await service.members(actor(req), typeof req.query.query === "string" ? req.query.query.trim() : "")); }));
  router.post("/admin/pap-currencies", route(async (req, res) => { res.status(201).json(await service.createCurrency(actor(req), req.body)); }));
  router.put("/admin/pap-currencies/:id", route(async (req, res) => { res.json(await service.editCurrency(actor(req), /^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : NaN, req.body)); }));
  router.post("/admin/pap-currencies/adjust", route(async (req, res) => { res.json(await service.adjust(actor(req), req.body)); }));
  return router;
}
