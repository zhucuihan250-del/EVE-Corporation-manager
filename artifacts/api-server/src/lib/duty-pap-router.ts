import { Router, type Request, type RequestHandler, type Response } from "express";
import { DutyPapError, type DutyPapActor } from "./duty-pap-rules";
import { PapCurrencyError } from "./pap-currency-math";
import type { createDutyPapService } from "./duty-pap-service";
export function createDutyPapRouter(deps: { service: ReturnType<typeof createDutyPapService>; requireAuth: RequestHandler; requireTenant: RequestHandler; requirePap: RequestHandler; requireFleet: RequestHandler }) {
  const router = Router(), windows = new Map<string, { start: number; count: number }>();
  const actor = (req: Request): DutyPapActor => ({ corporationId: req.tenant!.corporation.id, userId: req.tenant!.user.id, userName: req.tenant!.user.eveCharacterName ?? "成员", role: req.tenant!.membership.role });
  const limit: RequestHandler = (req, res, next) => {
    const now = Date.now(), key = `${actor(req).corporationId}:${actor(req).userId}:${req.method === "GET" ? "read" : "write"}`;
    for (const [key, window] of windows) if (now - window.start >= 60000) windows.delete(key);
    const current = windows.get(key); if ((current?.count ?? 0) >= (req.method === "GET" ? 120 : 30) || (!current && windows.size >= 5000)) { res.status(429).json({ error: "操作过于频繁，请稍后重试。", code: "DUTY_PAP_RATE_LIMIT" }); return; }
    windows.set(key, { start: current?.start ?? now, count: (current?.count ?? 0) + 1 });
    if (Buffer.byteLength(JSON.stringify(req.body ?? {})) > 16384) { res.status(413).json({ error: "值守规则过大。", code: "DUTY_PAP_PAYLOAD_LIMIT" }); return; } next();
  };
  for (const path of ["/duty-pap", "/admin/duty-pap"]) router.use(path, deps.requireAuth, deps.requireTenant, deps.requirePap, deps.requireFleet, limit);
  router.use("/admin/duty-pap", (req, res, next) => { if (!["admin", "controller"].includes(actor(req).role)) { res.status(403).json({ error: "只有管理员或总监可以管理自动值守 PAP。", code: "DUTY_PAP_ADMIN_REQUIRED" }); return; } next(); });
  const safe = (handler: (req: Request, res: Response) => Promise<void>): RequestHandler => async (req, res) => {
    try { await handler(req, res); } catch (error) {
      if (error instanceof DutyPapError || error instanceof PapCurrencyError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      const code = (error as { code?: string; cause?: { code?: string } })?.cause?.code ?? (error as { code?: string })?.code;
      if (code === "23505") { res.status(409).json({ error: "该舰队已有启用规则，或请求已处理，请刷新。", code: "DUTY_PAP_CONFLICT" }); return; }
      req.log?.error({ code: "DUTY_PAP_UNAVAILABLE" }, "Duty PAP request failed"); res.status(503).json({ error: "值守 PAP 服务暂时不可用。", code: "DUTY_PAP_UNAVAILABLE" });
    }
  };
  router.get("/duty-pap", safe(async (req, res) => { res.json(await deps.service.memberDashboard(actor(req))); }));
  router.post("/duty-pap/connection", safe(async (req, res) => { res.json(await deps.service.setConnectionEnabled(actor(req), req.body)); }));
  router.get("/admin/duty-pap", safe(async (req, res) => { res.json(await deps.service.adminDashboard(actor(req))); }));
  router.post("/admin/duty-pap/rules", safe(async (req, res) => { res.status(201).json(await deps.service.createRule(actor(req), req.body)); }));
  router.put("/admin/duty-pap/rules/:id", safe(async (req, res) => { res.json(await deps.service.updateRule(actor(req), /^\d+$/.test(String(req.params.id)) ? Number(req.params.id) : NaN, req.body)); }));
  return router;
}
