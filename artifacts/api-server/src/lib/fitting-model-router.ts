import { Router, type Request, type RequestHandler, type Response } from "express";
import { FittingModelError, getFittingModel, getFittingModelSource, getFittingResource, validateFittingResourcePath } from "./fitting-models";

type RouteLimits = { windowMs: number; requests: number; users: number; perUserBytes: number; globalBytes: number };
export const FITTING_MODEL_ROUTE_LIMITS: Readonly<RouteLimits> = Object.freeze({ windowMs: 60_000, requests: 1200, users: 5000, perUserBytes: 256 * 1024 * 1024, globalBytes: 512 * 1024 * 1024 });
type Dependencies = { getModel: typeof getFittingModel; getSource: typeof getFittingModelSource; getResource: typeof getFittingResource; now(): number; limits: typeof FITTING_MODEL_ROUTE_LIMITS };
type Window = { count: number; bytes: number; start: number };

/** Optional adapters are for isolated tests; production uses its real
 * auth/tenant/module guards and the bounded public CCP resource source. */
export function createFittingModelRouter(guards: RequestHandler[], overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = { getModel: getFittingModel, getSource: getFittingModelSource, getResource: getFittingResource, now: Date.now, limits: FITTING_MODEL_ROUTE_LIMITS, ...overrides };
  const router = Router(), windows = new Map<number, Window>();
  let globalWindow = { start: dependencies.now(), bytes: 0 };
  const key = (req: Request) => req.tenant?.user.id;
  const retryAfter = (res: Response, start: number) => res.set("Retry-After", String(Math.max(1, Math.ceil((dependencies.limits.windowMs - (dependencies.now() - start)) / 1000))));
  function clean(now: number) {
    for (const [id, entry] of windows) if (now - entry.start >= dependencies.limits.windowMs) windows.delete(id);
    if (now - globalWindow.start >= dependencies.limits.windowMs) globalWindow = { start: now, bytes: 0 };
  }
  function reserveBytes(req: Request, res: Response, byteLength: number) {
    // HEAD and conditional 304 have no resource body, but consume request rate.
    if (req.method === "HEAD") return true;
    const now = dependencies.now(); clean(now);
    const id = key(req)!, entry = windows.get(id) ?? { count: 0, bytes: 0, start: now };
    const rejectHeaders = () => { res.removeHeader("ETag"); res.set("Cache-Control", "private, no-store"); };
    if (!windows.has(id) && windows.size >= dependencies.limits.users) {
      rejectHeaders();
      retryAfter(res, now).status(429).json({ error: "3D 资源请求过于频繁。", code: "FITTING_MODEL_RATE_LIMIT" }); return false;
    }
    if (entry.bytes + byteLength > dependencies.limits.perUserBytes) {
      rejectHeaders();
      retryAfter(res, entry.start).status(429).json({ error: "本分钟 3D 资源加载量已达上限，请稍后重试。", code: "FITTING_MODEL_USER_BYTE_LIMIT" }); return false;
    }
    if (globalWindow.bytes + byteLength > dependencies.limits.globalBytes) {
      rejectHeaders();
      retryAfter(res, globalWindow.start).status(429).json({ error: "3D 资源服务本分钟加载量已达上限，请稍后重试。", code: "FITTING_MODEL_GLOBAL_BYTE_LIMIT" }); return false;
    }
    // Synchronous check/reserve makes concurrent cached responses atomic.
    entry.bytes += byteLength; windows.set(id, entry); globalWindow.bytes += byteLength;
    return true;
  }
  router.use("/fitting/3d", ...guards, (req, res, next) => {
    const now = dependencies.now(), id = key(req), corporationId = req.tenant?.corporation.id;
    if (!Number.isSafeInteger(id) || id! <= 0 || !Number.isSafeInteger(corporationId) || corporationId! <= 0
      || (req.session?.userId !== undefined && req.session.userId !== id)) {
      res.status(401).json({ error: "请先登录。", code: "FITTING_MODEL_AUTH_REQUIRED" }); return;
    }
    // Production previews are same-origin. SameSite=None cookies also enable
    // cross-site <img> requests, which must not spend a member's proxy quota.
    if (req.get("Sec-Fetch-Site") === "cross-site") {
      res.status(403).json({ error: "3D 资源不允许跨站加载。", code: "FITTING_MODEL_CROSS_SITE_FORBIDDEN" }); return;
    }
    clean(now);
    const entry = windows.get(id!) ?? { count: 0, bytes: 0, start: now };
    if (entry.count >= dependencies.limits.requests || (!windows.has(id!) && windows.size >= dependencies.limits.users)) {
      retryAfter(res, entry.start).status(429).json({ error: "3D 资源请求过于频繁。", code: "FITTING_MODEL_RATE_LIMIT" }); return;
    }
    entry.count++; windows.set(id!, entry); next();
  });
  const route = (handler: RequestHandler): RequestHandler => async (req, res, next) => {
    try { await handler(req, res, next); } catch (error) {
      if (error instanceof FittingModelError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
      next(error);
    }
  };
  function positiveInteger(value: unknown, label: string) {
    if (typeof value !== "string" || !/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2_147_483_647) throw new FittingModelError(400, "FITTING_MODEL_INVALID_TYPE", `${label}编号无效。`);
    return Number(value);
  }
  router.get("/fitting/3d/model/:id", route(async (req, res) => {
    const id = positiveInteger(req.params.id, "舰船");
    if (Object.keys(req.query).some(name => name !== "subsystems")) throw new FittingModelError(400, "FITTING_MODEL_INVALID_QUERY", "模型请求参数无效。");
    const raw = req.query.subsystems;
    if (raw !== undefined && (typeof raw !== "string" || raw.length > 54)) throw new FittingModelError(400, "FITTING_MODEL_INVALID_TYPE", "子系统编号列表无效。");
    const values = raw ? (raw as string).split(",") : [];
    if (values.length > 5) throw new FittingModelError(400, "FITTING_MODEL_INVALID_TYPE", "子系统编号列表无效。");
    const subsystemIds = values.map(value => positiveInteger(value, "子系统"));
    if (new Set(subsystemIds).size !== subsystemIds.length) throw new FittingModelError(400, "FITTING_MODEL_INVALID_TYPE", "子系统编号不能重复。");
    const model = dependencies.getModel(id, subsystemIds), build = await dependencies.getSource();
    if (!Number.isSafeInteger(build.clientBuild) || build.clientBuild <= 0 || build.clientBuild > 2_147_483_647) throw new FittingModelError(502, "FITTING_MODEL_BUILD_INVALID", "EVE 模型资源版本无效，请稍后重试。");
    const body = { ...model, ...build, resourceRoot: `/api/fitting/3d/resources/${build.clientBuild}/` };
    if (!reserveBytes(req, res, Buffer.byteLength(JSON.stringify(body), "utf8"))) return;
    res.set({ "Cache-Control": "private, no-cache", "X-Content-Type-Options": "nosniff" }).json(body);
  }));
  router.get(/^\/fitting\/3d\/resources\/(\d+)\/(.+)$/, route(async (req, res) => {
    const build = positiveInteger(req.params[0], "模型版本");
    if (Object.keys(req.query).length) throw new FittingModelError(400, "FITTING_MODEL_INVALID_QUERY", "模型资源请求参数无效。");
    const resourcePath = String(req.params[1]);
    validateFittingResourcePath(resourcePath);
    const { bytes, etag } = await dependencies.getResource(build, resourcePath);
    res.set({ ETag: etag, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    // A SHA-256 resource ETag has no commas; weak comparisons, lists and '*'
    // can therefore be resolved before Express possibly removes the body.
    const condition = req.get("If-None-Match");
    if (condition?.split(",").some(value => value.trim() === "*" || value.trim().replace(/^W\//, "") === etag.replace(/^W\//, ""))) { res.status(304).end(); return; }
    if (!reserveBytes(req, res, bytes.byteLength)) return;
    res.set({ "Content-Type": /\.png$/i.test(resourcePath) ? "image/png" : "application/octet-stream", "ETag": etag, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" });
    res.send(bytes);
  }));
  return router;
}
