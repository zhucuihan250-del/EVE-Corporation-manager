import express, { Router, type ErrorRequestHandler, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { ForumError, forumAttachmentId, forumId, type ForumActor } from "./forum-rules";
import type { createForumService } from "./forum-service";

/** Also mounted by app.ts after global JSON parser errors, with no raw body,
 * stack, uploaded content or SQL details in logging/responses. */
export const forumErrorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) { next(error); return; }
  if (error instanceof ForumError) { res.status(error.status).json({ error: error.message, code: error.code }); return; }
  const details = error && typeof error === "object" ? error as { status?: number; type?: string } : {};
  if (details.status === 413 || details.type === "entity.too.large") { res.status(413).json({ error: "内容或附件过大；单个附件最多 5 MiB。", code: "FORUM_PAYLOAD_LIMIT" }); return; }
  if (error instanceof URIError || details.status === 400 || ["entity.parse.failed", "request.aborted", "request.size.invalid"].includes(details.type ?? "")) { res.status(400).json({ error: "提交内容或上传请求无效。", code: "FORUM_INVALID_INPUT" }); return; }
  if (details.status === 415) { res.status(415).json({ error: "附件编码不受支持。", code: "FORUM_UNSUPPORTED_FILE" }); return; }
  req.log?.error({ errorCode: "FORUM_UNAVAILABLE" }, "Forum request failed");
  res.status(503).json({ error: "贴吧暂时不可用，请稍后重试。", code: "FORUM_UNAVAILABLE" });
};

export function createForumRouter(dependencies: { service: ReturnType<typeof createForumService>; requireAuth: RequestHandler; requireTenant: RequestHandler }) {
  const router = Router(), service = dependencies.service;
  const actor = (req: Request): ForumActor => ({ corporationId: req.tenant!.corporation.id, userId: req.tenant!.user.id, userName: req.tenant!.actorCharacter?.eveCharacterName ?? req.tenant!.user.eveCharacterName ?? `成员 ${req.tenant!.user.id}`, role: req.tenant!.membership.role });
  const windows = new Map<string, { start: number; count: number }>();
  const rateLimit: RequestHandler = (req, res, next) => {
    const current = actor(req), now = Date.now(), kind = req.method === "GET" ? "read" : req.method === "POST" && req.path === "/attachments" ? "upload" : "write", maximum = kind === "read" ? 120 : kind === "upload" ? 12 : 30;
    for (const [key, window] of windows) if (now - window.start >= 60_000) windows.delete(key);
    const key = `${current.corporationId}:${current.userId}:${kind}`, previous = windows.get(key);
    if ((previous?.count ?? 0) >= maximum || (!previous && windows.size >= 5000)) { res.setHeader("Retry-After", "60"); res.status(429).json({ error: "操作过于频繁，请稍后重试。", code: "FORUM_RATE_LIMIT" }); return; }
    windows.set(key, { start: previous?.start ?? now, count: (previous?.count ?? 0) + 1 });
    if (req.method !== "GET" && !Buffer.isBuffer(req.body) && Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8") > 96 * 1024) { res.status(413).json({ error: "提交内容过大。", code: "FORUM_PAYLOAD_LIMIT" }); return; }
    next();
  };
  router.use("/forum", dependencies.requireAuth, dependencies.requireTenant, rateLimit, (_req, res, next) => { res.setHeader("Cache-Control", "private, no-store"); next(); });
  const route = (handler: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response, next: NextFunction) => { try { await handler(req, res); } catch (error) { forumErrorHandler(error, req, res, next); } };
  router.get("/forum/posts", route(async (req, res) => { res.json(await service.listPosts(actor(req), { query: req.query.query, page: req.query.page })); }));
  router.get("/forum/posts/:id", route(async (req, res) => { res.json(await service.getPost(actor(req), forumId(req.params.id), { replyPage: req.query.replyPage })); }));
  router.post("/forum/posts", route(async (req, res) => { res.status(201).json(await service.createPost(actor(req), req.body)); }));
  router.patch("/forum/posts/:id", route(async (req, res) => { res.json(await service.updatePost(actor(req), forumId(req.params.id), req.body)); }));
  router.delete("/forum/posts/:id", route(async (req, res) => { res.json(await service.deletePost(actor(req), forumId(req.params.id))); }));
  router.patch("/forum/posts/:id/moderation", route(async (req, res) => { res.json(await service.moderatePost(actor(req), forumId(req.params.id), req.body)); }));
  router.post("/forum/posts/:id/replies", route(async (req, res) => { res.status(201).json(await service.createReply(actor(req), forumId(req.params.id), req.body)); }));
  router.patch("/forum/replies/:id", route(async (req, res) => { res.json(await service.updateReply(actor(req), forumId(req.params.id), req.body)); }));
  router.delete("/forum/replies/:id", route(async (req, res) => { res.json(await service.deleteReply(actor(req), forumId(req.params.id))); }));
  // Parsing is after validated authentication/tenant and rate checks; inflate
  // disabled prevents tiny compressed uploads from bypassing the byte limit.
  router.post("/forum/attachments", express.raw({ type: () => true, limit: 5 * 1024 * 1024, inflate: false }), route(async (req, res) => { res.status(201).json(await service.uploadAttachment(actor(req), req.body, req.headers["content-type"], req.headers["x-file-name"])); }));
  const file = (download: boolean) => route(async (req, res) => {
    const result = await service.getAttachment(actor(req), forumAttachmentId(req.params.id));
    const extension = result.fileName.split(".").at(-1)!, encodedName = encodeURIComponent(result.fileName).replace(/[!'()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; frame-ancestors 'none'");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Content-Disposition", `${download || !result.mimeType.startsWith("image/") ? "attachment" : "inline"}; filename="attachment.${extension}"; filename*=UTF-8''${encodedName}`);
    res.type(result.mimeType).send(result.bytes);
  });
  router.get("/forum/attachments/:id", file(false));
  router.get("/forum/attachments/:id/download", file(true));
  router.delete("/forum/attachments/:id", route(async (req, res) => { res.json(await service.deleteDraftAttachment(actor(req), forumAttachmentId(req.params.id))); }));
  router.use("/forum", forumErrorHandler);
  return router;
}
