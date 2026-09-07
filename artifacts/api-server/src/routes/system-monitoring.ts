import { Router, type IRouter, type Request, type Response } from "express";
import { hasRole, requireAuth } from "../middlewares/auth";
import { hasPermission, requireModule, requireTenant } from "../lib/tenant";
import {
  authenticateBridge,
  bridgeConfig,
  createBridgePairing,
  createManualIntelReport,
  createMonitoredSystem,
  ingestBridgeEvents,
  listIntelBridges,
  listMonitoredSystems,
  loadSystemMonitoringDashboard,
  pairBridge,
  removeMonitoredSystem,
  updateBridge,
  updateBridgeHeartbeat,
  updateMonitoredSystem,
  type IncomingChatEvent,
} from "../lib/system-monitoring";
import { searchSolarSystems } from "../lib/solar-system-search";

const router: IRouter = Router();

function managerAllowed(req: Request): boolean {
  return Boolean(
    req.tenant &&
    (hasRole(req.tenant.membership.role, "fc") ||
      hasPermission(req.tenant, "fleet.manage")),
  );
}

function requestBody(req: Request): Record<string, unknown> {
  return req.body && typeof req.body === "object"
    ? (req.body as Record<string, unknown>)
    : {};
}

async function getBridgeAuth(req: Request, res: Response) {
  const auth = await authenticateBridge(req.get("authorization"));
  if (!auth) res.status(401).json({ error: "桥接器令牌无效或已被停用" });
  return auth;
}

router.post(
  "/system-monitoring/bridge/pair",
  async (req: Request, res: Response): Promise<void> => {
    const body = requestBody(req);
    const code = typeof body.code === "string" ? body.code.trim() : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const platform =
      typeof body.platform === "string" ? body.platform.trim() : null;
    if (
      code.length < 12 ||
      code.length > 64 ||
      !name ||
      name.length > 120 ||
      (platform && platform.length > 120)
    ) {
      res.status(400).json({ error: "桥接器配对信息无效" });
      return;
    }
    const paired = await pairBridge({
      code,
      name,
      platform,
      channelNames: body.channelNames,
    });
    if (!paired) {
      res.status(401).json({ error: "配对码无效、已使用或已过期" });
      return;
    }
    res.status(201).json({
      bridgeId: paired.bridge.id,
      corporationId: paired.bridge.corporationId,
      token: paired.token,
    });
  },
);

router.get(
  "/system-monitoring/bridge/config",
  async (req: Request, res: Response): Promise<void> => {
    const auth = await getBridgeAuth(req, res);
    if (!auth) return;
    res.json(await bridgeConfig(auth));
  },
);

router.post(
  "/system-monitoring/bridge/heartbeat",
  async (req: Request, res: Response): Promise<void> => {
    const auth = await getBridgeAuth(req, res);
    if (!auth) return;
    const body = requestBody(req);
    const lastError =
      typeof body.lastError === "string" ? body.lastError : null;
    await updateBridgeHeartbeat(auth, lastError);
    res.json({ success: true, receivedAt: new Date() });
  },
);

router.post(
  "/system-monitoring/bridge/events",
  async (req: Request, res: Response): Promise<void> => {
    const auth = await getBridgeAuth(req, res);
    if (!auth) return;
    const body = requestBody(req);
    if (!Array.isArray(body.events) || body.events.length > 100) {
      res.status(400).json({ error: "桥接事件必须是最多100条的数组" });
      return;
    }
    res.json(
      await ingestBridgeEvents(auth, body.events as IncomingChatEvent[]),
    );
  },
);

router.use(
  "/system-monitoring",
  requireAuth,
  requireTenant,
  requireModule("fleet"),
);

router.get(
  "/system-monitoring",
  async (req: Request, res: Response): Promise<void> => {
    res.json(await loadSystemMonitoringDashboard(req.tenant!.corporation.id));
  },
);

router.post(
  "/system-monitoring/reports",
  async (req: Request, res: Response): Promise<void> => {
    const tenant = req.tenant!;
    if (!tenant.actorCharacter) {
      res
        .status(409)
        .json({ error: "请先使用本军团角色重新登录后提交实名情报" });
      return;
    }
    const body = requestBody(req);
    const monitorId = Number(body.monitorId);
    const enemyCount =
      body.enemyCount === undefined ||
      body.enemyCount === null ||
      body.enemyCount === ""
        ? null
        : Number(body.enemyCount);
    const ttlMinutes = Number(body.ttlMinutes ?? 10);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    const direction =
      typeof body.direction === "string" ? body.direction.trim() : null;
    const shipTags = Array.isArray(body.shipTags)
      ? body.shipTags
          .filter((item: unknown): item is string => typeof item === "string")
          .map((item: string) => item.trim())
          .filter(Boolean)
      : [];
    if (
      !Number.isInteger(monitorId) ||
      (enemyCount !== null &&
        (!Number.isInteger(enemyCount) ||
          enemyCount < 0 ||
          enemyCount > 1_000)) ||
      ![5, 10, 20, 30, 60].includes(ttlMinutes) ||
      !message ||
      message.length > 2_000 ||
      (direction && direction.length > 120) ||
      shipTags.length > 20
    ) {
      res.status(400).json({ error: "情报内容无效" });
      return;
    }
    const created = await createManualIntelReport({
      corporationId: tenant.corporation.id,
      userId: tenant.user.id,
      reporterCharacterName: tenant.actorCharacter.eveCharacterName,
      monitorId,
      enemyCount,
      shipTags,
      direction,
      message,
      ttlMinutes,
    });
    if (!created) {
      res.status(404).json({ error: "监控星系不存在或已停用" });
      return;
    }
    res.status(201).json(created);
  },
);

router.get(
  "/system-monitoring/system-search",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length < 2 || query.length > 100) {
      res.status(400).json({ error: "星系搜索词必须为2至100个字符" });
      return;
    }
    res.json(searchSolarSystems(query));
  },
);

router.get(
  "/system-monitoring/systems",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json(await listMonitoredSystems(req.tenant!.corporation.id));
  },
);

router.post(
  "/system-monitoring/systems",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const body = requestBody(req);
    const solarSystemName =
      typeof body.solarSystemName === "string"
        ? body.solarSystemName.trim()
        : "";
    const burstWindowMinutes = Number(body.burstWindowMinutes ?? 10);
    const burstThreshold = Number(body.burstThreshold ?? 3);
    const highValueThreshold = Number(body.highValueThreshold ?? 1_000_000_000);
    const activityMultiplier = Number(body.activityMultiplier ?? 1.5);
    const notes = typeof body.notes === "string" ? body.notes.trim() : null;
    if (
      !solarSystemName ||
      solarSystemName.length > 100 ||
      !Number.isInteger(burstWindowMinutes) ||
      burstWindowMinutes < 1 ||
      burstWindowMinutes > 60 ||
      !Number.isInteger(burstThreshold) ||
      burstThreshold < 2 ||
      burstThreshold > 50 ||
      !Number.isFinite(highValueThreshold) ||
      highValueThreshold < 0 ||
      highValueThreshold > 1e15 ||
      !Number.isFinite(activityMultiplier) ||
      activityMultiplier < 1 ||
      activityMultiplier > 20 ||
      (notes && notes.length > 2_000)
    ) {
      res.status(400).json({ error: "监控星系设置无效" });
      return;
    }
    try {
      const created = await createMonitoredSystem({
        corporationId: req.tenant!.corporation.id,
        createdBy: req.tenant!.user.id,
        solarSystemName,
        burstWindowMinutes,
        burstThreshold,
        highValueThreshold,
        activityMultiplier,
        notes,
      });
      res.status(201).json(created);
    } catch (error) {
      res.status(400).json({
        error: error instanceof Error ? error.message : "无法添加监控星系",
      });
    }
  },
);

router.patch(
  "/system-monitoring/systems/:id",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    const body = requestBody(req);
    const input = {
      isActive: typeof body.isActive === "boolean" ? body.isActive : undefined,
      burstWindowMinutes:
        body.burstWindowMinutes === undefined
          ? undefined
          : Number(body.burstWindowMinutes),
      burstThreshold:
        body.burstThreshold === undefined
          ? undefined
          : Number(body.burstThreshold),
      highValueThreshold:
        body.highValueThreshold === undefined
          ? undefined
          : Number(body.highValueThreshold),
      activityMultiplier:
        body.activityMultiplier === undefined
          ? undefined
          : Number(body.activityMultiplier),
      notes:
        body.notes === undefined
          ? undefined
          : typeof body.notes === "string"
            ? body.notes
            : null,
    };
    if (
      !Number.isInteger(id) ||
      (input.burstWindowMinutes !== undefined &&
        (!Number.isInteger(input.burstWindowMinutes) ||
          input.burstWindowMinutes < 1 ||
          input.burstWindowMinutes > 60)) ||
      (input.burstThreshold !== undefined &&
        (!Number.isInteger(input.burstThreshold) ||
          input.burstThreshold < 2 ||
          input.burstThreshold > 50)) ||
      (input.highValueThreshold !== undefined &&
        (!Number.isFinite(input.highValueThreshold) ||
          input.highValueThreshold < 0 ||
          input.highValueThreshold > 1e15)) ||
      (input.activityMultiplier !== undefined &&
        (!Number.isFinite(input.activityMultiplier) ||
          input.activityMultiplier < 1 ||
          input.activityMultiplier > 20)) ||
      (typeof input.notes === "string" && input.notes.length > 2_000)
    ) {
      res.status(400).json({ error: "监控星系设置无效" });
      return;
    }
    const updated = await updateMonitoredSystem(
      req.tenant!.corporation.id,
      id,
      input,
    );
    if (!updated) {
      res.status(404).json({ error: "监控星系不存在" });
      return;
    }
    res.json(updated);
  },
);

router.delete(
  "/system-monitoring/systems/:id",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: "监控星系编号无效" });
      return;
    }
    const removed = await removeMonitoredSystem(req.tenant!.corporation.id, id);
    if (!removed) {
      res.status(404).json({ error: "监控星系不存在" });
      return;
    }
    res.status(204).send();
  },
);

router.post(
  "/system-monitoring/pairings",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res
      .status(201)
      .json(
        await createBridgePairing(
          req.tenant!.corporation.id,
          req.tenant!.user.id,
        ),
      );
  },
);

router.get(
  "/system-monitoring/bridges",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    res.json(await listIntelBridges(req.tenant!.corporation.id));
  },
);

router.patch(
  "/system-monitoring/bridges/:id",
  async (req: Request, res: Response): Promise<void> => {
    if (!managerAllowed(req)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    const id = Number(req.params.id);
    const body = requestBody(req);
    const name =
      body.name === undefined
        ? undefined
        : typeof body.name === "string"
          ? body.name.trim()
          : "";
    const channelNames =
      body.channelNames === undefined ? undefined : body.channelNames;
    const isActive = body.isActive === undefined ? undefined : body.isActive;
    if (
      !Number.isInteger(id) ||
      (name !== undefined && (!name || name.length > 120)) ||
      (isActive !== undefined && typeof isActive !== "boolean")
    ) {
      res.status(400).json({ error: "桥接器设置无效" });
      return;
    }
    const updated = await updateBridge(req.tenant!.corporation.id, id, {
      name,
      channelNames,
      isActive,
    });
    if (!updated) {
      res.status(404).json({ error: "桥接器不存在" });
      return;
    }
    res.json(updated);
  },
);

export default router;
