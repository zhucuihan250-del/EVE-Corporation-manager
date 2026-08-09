import { Router, type IRouter, type Request, type Response } from "express";
import {
  charactersTable,
  corporationMembershipsTable,
  courierAgentsTable,
  courierOrdersTable,
  courierRoutesTable,
  db,
  usersTable,
} from "@workspace/db";
import { and, asc, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { hasRole, requireAuth } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";

const router: IRouter = Router();
router.use("/courier", requireAuth, requireTenant, requireModule("courier"));

const PRICING_METHODS = ["fixed", "volume", "collateral", "volume_collateral"] as const;
type PricingMethod = (typeof PRICING_METHODS)[number];
const ORDER_STATUSES = ["submitted", "accepted", "in_transit", "completed", "rejected", "cancelled"] as const;
type OrderStatus = (typeof ORDER_STATUSES)[number];

function canManage(req: Request): boolean {
  return Boolean(req.tenant && hasRole(req.tenant.membership.role, "admin"));
}

function finiteNumber(value: unknown, minimum: number, maximum: number): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function calculateFee(
  method: PricingMethod,
  baseFee: number,
  pricePerM3: number,
  collateralRate: number,
  volumeM3: number,
  collateral: number,
): number {
  let fee = baseFee;
  if (method === "volume" || method === "volume_collateral") fee += volumeM3 * pricePerM3;
  if (method === "collateral" || method === "volume_collateral") fee += collateral * collateralRate / 100;
  return Math.ceil(fee);
}

function pricingFormula(method: PricingMethod): string {
  if (method === "fixed") return "baseFee";
  if (method === "volume") return "baseFee + volumeM3 × pricePerM3";
  if (method === "collateral") return "baseFee + collateral × collateralRate%";
  return "baseFee + volumeM3 × pricePerM3 + collateral × collateralRate%";
}

function parsePricing(input: Record<string, unknown>) {
  const method = input.pricingMethod;
  const baseFee = finiteNumber(input.baseFee, 0, 9_000_000_000_000_000);
  const pricePerM3 = finiteNumber(input.pricePerM3, 0, 1_000_000_000_000);
  const collateralRate = finiteNumber(input.collateralRate, 0, 100);
  if (!PRICING_METHODS.includes(method as PricingMethod) || baseFee === null || pricePerM3 === null || collateralRate === null) {
    return null;
  }
  if (
    (method === "fixed" && baseFee <= 0)
    || (method === "volume" && baseFee <= 0 && pricePerM3 <= 0)
    || (method === "collateral" && baseFee <= 0 && collateralRate <= 0)
    || (method === "volume_collateral" && baseFee <= 0 && pricePerM3 <= 0 && collateralRate <= 0)
  ) return null;
  return { pricingMethod: method as PricingMethod, baseFee, pricePerM3, collateralRate };
}

async function listRoutes(corporationId: number, includeInactive: boolean) {
  return db.select({
    id: courierRoutesTable.id,
    corporationId: courierRoutesTable.corporationId,
    courierAgentId: courierRoutesTable.courierAgentId,
    courierName: courierAgentsTable.name,
    origin: courierRoutesTable.origin,
    destination: courierRoutesTable.destination,
    pricingMethod: courierRoutesTable.pricingMethod,
    baseFee: courierRoutesTable.baseFee,
    pricePerM3: courierRoutesTable.pricePerM3,
    collateralRate: courierRoutesTable.collateralRate,
    isActive: courierRoutesTable.isActive,
    createdAt: courierRoutesTable.createdAt,
    updatedAt: courierRoutesTable.updatedAt,
  }).from(courierRoutesTable).innerJoin(courierAgentsTable, and(
    eq(courierAgentsTable.id, courierRoutesTable.courierAgentId),
    eq(courierAgentsTable.corporationId, corporationId),
    ...(includeInactive ? [] : [eq(courierAgentsTable.isActive, true)]),
  )).where(and(
    eq(courierRoutesTable.corporationId, corporationId),
    ...(includeInactive ? [] : [eq(courierRoutesTable.isActive, true)]),
  )).orderBy(asc(courierRoutesTable.origin), asc(courierRoutesTable.destination), asc(courierAgentsTable.name));
}

async function getRoute(corporationId: number, routeId: number, activeOnly = true) {
  const routes = await db.select({
    route: courierRoutesTable,
    agent: courierAgentsTable,
  }).from(courierRoutesTable).innerJoin(courierAgentsTable, and(
    eq(courierAgentsTable.id, courierRoutesTable.courierAgentId),
    eq(courierAgentsTable.corporationId, corporationId),
  )).where(and(
    eq(courierRoutesTable.id, routeId),
    eq(courierRoutesTable.corporationId, corporationId),
    ...(activeOnly ? [eq(courierRoutesTable.isActive, true), eq(courierAgentsTable.isActive, true)] : []),
  ));
  return routes[0] ?? null;
}

async function getCurrentCourierAgent(corporationId: number, userId: number, activeOnly = false) {
  const [agent] = await db.select().from(courierAgentsTable).where(and(
    eq(courierAgentsTable.corporationId, corporationId),
    eq(courierAgentsTable.userId, userId),
    ...(activeOnly ? [eq(courierAgentsTable.isActive, true)] : []),
  ));
  return agent ?? null;
}

function publicOrder(row: typeof courierOrdersTable.$inferSelect, showInternal: boolean, canManageStatus: boolean) {
  return { ...row, internalNotes: showInternal ? row.internalNotes : null, canManageStatus };
}

router.get("/courier/routes", async (req: Request, res: Response): Promise<void> => {
  res.json(await listRoutes(req.tenant!.corporation.id, false));
});

router.get("/courier/profile", async (req: Request, res: Response): Promise<void> => {
  const corporationId = req.tenant!.corporation.id;
  const agent = await getCurrentCourierAgent(corporationId, req.tenant!.user.id);
  if (!agent || !agent.isActive) {
    res.json({ isCourier: false, routes: [] });
    return;
  }
  const routes = (await listRoutes(corporationId, true)).filter((route) => route.courierAgentId === agent.id);
  res.json({
    isCourier: true,
    agent: { ...agent, routeCount: routes.length },
    routes,
  });
});

router.post("/courier/routes", async (req: Request, res: Response): Promise<void> => {
  const corporationId = req.tenant!.corporation.id;
  const agent = await getCurrentCourierAgent(corporationId, req.tenant!.user.id, true);
  if (!agent) {
    res.status(403).json({ error: "Active courier access required" });
    return;
  }
  const origin = typeof req.body.origin === "string" ? req.body.origin.trim().slice(0, 200) : "";
  const destination = typeof req.body.destination === "string" ? req.body.destination.trim().slice(0, 200) : "";
  const pricing = parsePricing(req.body);
  if (!origin || !destination || origin.toLocaleLowerCase() === destination.toLocaleLowerCase() || !pricing || typeof req.body.isActive !== "boolean") {
    res.status(400).json({ error: "Invalid courier route" });
    return;
  }
  const [created] = await db.insert(courierRoutesTable).values({
    corporationId,
    courierAgentId: agent.id,
    origin,
    destination,
    ...pricing,
    isActive: req.body.isActive,
  }).returning();
  res.status(201).json({ ...created, courierName: agent.name });
});

router.patch("/courier/routes/:id", async (req: Request, res: Response): Promise<void> => {
  const corporationId = req.tenant!.corporation.id;
  const id = Number(req.params.id);
  const agent = await getCurrentCourierAgent(corporationId, req.tenant!.user.id, true);
  const origin = typeof req.body.origin === "string" ? req.body.origin.trim().slice(0, 200) : "";
  const destination = typeof req.body.destination === "string" ? req.body.destination.trim().slice(0, 200) : "";
  const pricing = parsePricing(req.body);
  if (!agent) {
    res.status(403).json({ error: "Active courier access required" });
    return;
  }
  if (!Number.isInteger(id) || !origin || !destination || origin.toLocaleLowerCase() === destination.toLocaleLowerCase() || !pricing || typeof req.body.isActive !== "boolean") {
    res.status(400).json({ error: "Invalid courier route update" });
    return;
  }
  const [updated] = await db.update(courierRoutesTable).set({
    origin,
    destination,
    ...pricing,
    isActive: req.body.isActive,
  }).where(and(
    eq(courierRoutesTable.id, id),
    eq(courierRoutesTable.corporationId, corporationId),
    eq(courierRoutesTable.courierAgentId, agent.id),
  )).returning();
  if (!updated) {
    res.status(404).json({ error: "Courier route not found" });
    return;
  }
  res.json({ ...updated, courierName: agent.name });
});

router.post("/courier/quote", async (req: Request, res: Response): Promise<void> => {
  const routeId = Number(req.body.routeId);
  const volumeM3 = finiteNumber(req.body.volumeM3, 0.01, 2_000_000_000);
  const collateral = finiteNumber(req.body.collateral, 0, 9_000_000_000_000_000);
  if (!Number.isInteger(routeId) || volumeM3 === null || collateral === null) {
    res.status(400).json({ error: "Invalid courier quote" });
    return;
  }
  const route = await getRoute(req.tenant!.corporation.id, routeId);
  if (!route) {
    res.status(404).json({ error: "Courier route not found" });
    return;
  }
  const calculatedFee = calculateFee(
    route.route.pricingMethod,
    route.route.baseFee,
    route.route.pricePerM3,
    route.route.collateralRate,
    volumeM3,
    collateral,
  );
  if (!Number.isSafeInteger(calculatedFee) || calculatedFee > 9_000_000_000_000_000) {
    res.status(400).json({ error: "Calculated courier fee is too large" });
    return;
  }
  res.json({
    routeId,
    courierName: route.agent.name,
    origin: route.route.origin,
    destination: route.route.destination,
    volumeM3,
    collateral,
    calculatedFee,
    formula: pricingFormula(route.route.pricingMethod),
  });
});

router.get("/courier/orders", async (req: Request, res: Response): Promise<void> => {
  const corporationId = req.tenant!.corporation.id;
  const userId = req.tenant!.user.id;
  const admin = canManage(req);
  const agentRows = admin ? [] : await db.select({ id: courierAgentsTable.id }).from(courierAgentsTable).where(and(
    eq(courierAgentsTable.corporationId, corporationId),
    eq(courierAgentsTable.userId, userId),
  ));
  const agentIds = agentRows.map((row) => row.id);
  const visibility = admin
    ? undefined
    : agentIds.length > 0
      ? or(eq(courierOrdersTable.submittedBy, userId), inArray(courierOrdersTable.courierAgentId, agentIds))
      : eq(courierOrdersTable.submittedBy, userId);
  const rows = await db.select().from(courierOrdersTable).where(and(
    eq(courierOrdersTable.corporationId, corporationId),
    ...(visibility ? [visibility] : []),
  )).orderBy(desc(courierOrdersTable.createdAt));
  res.json(rows.map((row) => publicOrder(
    row,
    admin || agentIds.includes(row.courierAgentId) || row.status === "completed",
    admin || agentIds.includes(row.courierAgentId),
  )));
});

router.post("/courier/orders", async (req: Request, res: Response): Promise<void> => {
  const tenant = req.tenant!;
  const routeId = Number(req.body.routeId);
  const volumeM3 = finiteNumber(req.body.volumeM3, 0.01, 2_000_000_000);
  const collateral = finiteNumber(req.body.collateral, 0, 9_000_000_000_000_000);
  const quotedFee = finiteNumber(req.body.quotedFee, 0, 9_000_000_000_000_000);
  const note = typeof req.body.note === "string" ? req.body.note.trim().slice(0, 5_000) : "";
  if (!Number.isInteger(routeId) || volumeM3 === null || collateral === null || quotedFee === null) {
    res.status(400).json({ error: "Invalid courier order" });
    return;
  }
  const route = await getRoute(tenant.corporation.id, routeId);
  if (!route) {
    res.status(404).json({ error: "Courier route not found" });
    return;
  }
  const calculatedFee = calculateFee(
    route.route.pricingMethod,
    route.route.baseFee,
    route.route.pricePerM3,
    route.route.collateralRate,
    volumeM3,
    collateral,
  );
  if (!Number.isSafeInteger(calculatedFee) || calculatedFee > 9_000_000_000_000_000) {
    res.status(400).json({ error: "Calculated courier fee is too large" });
    return;
  }
  if (calculatedFee !== quotedFee) {
    res.status(409).json({ error: "线路价格已发生变化，请重新计算并确认快递费" });
    return;
  }
  const submitterName = tenant.actorCharacter?.eveCharacterName || tenant.user.eveCharacterName;
  if (!submitterName) {
    res.status(409).json({ error: "请先用本军团角色重新登录后提交" });
    return;
  }
  const [created] = await db.insert(courierOrdersTable).values({
    corporationId: tenant.corporation.id,
    routeId: route.route.id,
    courierAgentId: route.agent.id,
    submittedBy: tenant.user.id,
    submitterName,
    courierName: route.agent.name,
    origin: route.route.origin,
    destination: route.route.destination,
    pricingMethod: route.route.pricingMethod,
    baseFee: route.route.baseFee,
    pricePerM3: route.route.pricePerM3,
    collateralRate: route.route.collateralRate,
    volumeM3,
    collateral,
    calculatedFee,
    note: note || null,
  }).returning();
  res.status(201).json(publicOrder(created, false, false));
});

router.patch("/courier/orders/:id", async (req: Request, res: Response): Promise<void> => {
  const orderId = Number(req.params.id);
  const status = req.body.status as OrderStatus;
  if (!Number.isInteger(orderId) || !ORDER_STATUSES.includes(status)) {
    res.status(400).json({ error: "Invalid courier order update" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const userId = req.tenant!.user.id;
  const [order] = await db.select().from(courierOrdersTable).where(and(
    eq(courierOrdersTable.id, orderId),
    eq(courierOrdersTable.corporationId, corporationId),
  ));
  if (!order) {
    res.status(404).json({ error: "Courier order not found" });
    return;
  }
  const [assignedAgent] = await db.select().from(courierAgentsTable).where(and(
    eq(courierAgentsTable.id, order.courierAgentId),
    eq(courierAgentsTable.corporationId, corporationId),
    eq(courierAgentsTable.userId, userId),
  ));
  const admin = canManage(req);
  const courier = Boolean(assignedAgent);
  const ownerCancellation = order.submittedBy === userId && order.status === "submitted" && status === "cancelled";
  if (!admin && !courier && !ownerCancellation) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const transitions: Record<OrderStatus, OrderStatus[]> = {
    submitted: ["accepted", "rejected", "cancelled"],
    accepted: ["in_transit", "rejected", "cancelled"],
    in_transit: ["completed", "cancelled"],
    completed: [],
    rejected: [],
    cancelled: [],
  };
  if (!transitions[order.status].includes(status)) {
    res.status(409).json({ error: "Courier order status cannot make this transition" });
    return;
  }
  const now = new Date();
  const internalNotes = (admin || courier) && typeof req.body.internalNotes === "string"
    ? req.body.internalNotes.trim().slice(0, 5_000) || null
    : order.internalNotes;
  const [updated] = await db.update(courierOrdersTable).set({
    status,
    internalNotes,
    acceptedAt: ["accepted", "in_transit", "completed"].includes(status) ? order.acceptedAt ?? now : order.acceptedAt,
    completedAt: status === "completed" ? now : order.completedAt,
  }).where(and(
    eq(courierOrdersTable.id, orderId),
    eq(courierOrdersTable.corporationId, corporationId),
  )).returning();
  res.json(publicOrder(updated, admin || courier, admin || courier));
});

router.get("/courier/admin", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const [members, characters, agents, routes] = await Promise.all([
    db.select({
      userId: usersTable.id,
      userName: usersTable.eveCharacterName,
    }).from(corporationMembershipsTable).innerJoin(usersTable, eq(usersTable.id, corporationMembershipsTable.userId)).where(
      eq(corporationMembershipsTable.corporationId, corporationId),
    ).orderBy(asc(usersTable.eveCharacterName), asc(usersTable.id)),
    db.select().from(charactersTable).where(and(
      eq(charactersTable.corporationId, corporationId),
      isNull(charactersTable.deletedAt),
    )).orderBy(desc(charactersTable.isMain), asc(charactersTable.createdAt)),
    db.select({
      id: courierAgentsTable.id,
      corporationId: courierAgentsTable.corporationId,
      userId: courierAgentsTable.userId,
      name: courierAgentsTable.name,
      isActive: courierAgentsTable.isActive,
      routeCount: sql<number>`(
        SELECT COUNT(*)::int FROM "courier_routes"
        WHERE "courier_routes"."courier_agent_id" = "courier_agents"."id"
      )`,
      createdAt: courierAgentsTable.createdAt,
      updatedAt: courierAgentsTable.updatedAt,
    }).from(courierAgentsTable).where(eq(courierAgentsTable.corporationId, corporationId)).orderBy(asc(courierAgentsTable.name)),
    listRoutes(corporationId, true),
  ]);
  const characterByUser = new Map<number, string>();
  for (const character of characters) {
    if (character.userId && !characterByUser.has(character.userId)) characterByUser.set(character.userId, character.eveCharacterName);
  }
  const courierUserIds = new Set(agents.map((agent) => agent.userId).filter((id): id is number => id !== null));
  res.json({
    candidates: members.map((member) => ({
      userId: member.userId,
      name: characterByUser.get(member.userId) ?? member.userName ?? `Pilot #${member.userId}`,
      isCourier: courierUserIds.has(member.userId),
    })),
    agents,
    routes,
  });
});

router.post("/courier/admin/agents", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const userId = Number(req.body.userId);
  if (!Number.isInteger(userId)) {
    res.status(400).json({ error: "Invalid courier member" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const [membership, duplicate] = await Promise.all([
    db.select().from(corporationMembershipsTable).where(and(
      eq(corporationMembershipsTable.corporationId, corporationId),
      eq(corporationMembershipsTable.userId, userId),
    )).then((rows) => rows[0] ?? null),
    db.select().from(courierAgentsTable).where(and(
      eq(courierAgentsTable.corporationId, corporationId),
      eq(courierAgentsTable.userId, userId),
    )).then((rows) => rows[0] ?? null),
  ]);
  if (!membership) {
    res.status(404).json({ error: "Corporation member not found" });
    return;
  }
  if (duplicate) {
    res.status(409).json({ error: "This member is already a courier" });
    return;
  }
  const [character, user] = await Promise.all([
    db.select().from(charactersTable).where(and(
      eq(charactersTable.corporationId, corporationId),
      eq(charactersTable.userId, userId),
      isNull(charactersTable.deletedAt),
    )).orderBy(desc(charactersTable.isMain), asc(charactersTable.createdAt)).then((rows) => rows[0] ?? null),
    db.select().from(usersTable).where(eq(usersTable.id, userId)).then((rows) => rows[0] ?? null),
  ]);
  const name = character?.eveCharacterName ?? user?.eveCharacterName ?? `Pilot #${userId}`;
  const [created] = await db.insert(courierAgentsTable).values({
    corporationId,
    userId,
    name,
    createdBy: req.tenant!.user.id,
  }).returning();
  res.status(201).json({ ...created, routeCount: 0 });
});

router.patch("/courier/admin/agents/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const name = typeof req.body.name === "string" ? req.body.name.trim().slice(0, 200) : "";
  const isActive = req.body.isActive;
  if (!Number.isInteger(id) || !name || typeof isActive !== "boolean") {
    res.status(400).json({ error: "Invalid courier update" });
    return;
  }
  const [updated] = await db.update(courierAgentsTable).set({ name, isActive }).where(and(
    eq(courierAgentsTable.id, id),
    eq(courierAgentsTable.corporationId, req.tenant!.corporation.id),
  )).returning();
  if (!updated) {
    res.status(404).json({ error: "Courier not found" });
    return;
  }
  if (!isActive) {
    await db.update(courierRoutesTable).set({ isActive: false }).where(and(
      eq(courierRoutesTable.corporationId, req.tenant!.corporation.id),
      eq(courierRoutesTable.courierAgentId, id),
    ));
  }
  const [{ routeCount }] = await db.select({ routeCount: sql<number>`COUNT(*)::int` }).from(courierRoutesTable).where(and(
    eq(courierRoutesTable.corporationId, req.tenant!.corporation.id),
    eq(courierRoutesTable.courierAgentId, id),
  ));
  res.json({ ...updated, routeCount: Number(routeCount ?? 0) });
});

router.post("/courier/admin/routes", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const courierAgentId = Number(req.body.courierAgentId);
  const origin = typeof req.body.origin === "string" ? req.body.origin.trim().slice(0, 200) : "";
  const destination = typeof req.body.destination === "string" ? req.body.destination.trim().slice(0, 200) : "";
  const pricing = parsePricing(req.body);
  if (!Number.isInteger(courierAgentId) || !origin || !destination || origin.toLocaleLowerCase() === destination.toLocaleLowerCase() || !pricing) {
    res.status(400).json({ error: "Invalid courier route" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const [agent] = await db.select().from(courierAgentsTable).where(and(
    eq(courierAgentsTable.id, courierAgentId),
    eq(courierAgentsTable.corporationId, corporationId),
    eq(courierAgentsTable.isActive, true),
  ));
  if (!agent) {
    res.status(404).json({ error: "Active courier not found" });
    return;
  }
  const [created] = await db.insert(courierRoutesTable).values({
    corporationId,
    courierAgentId,
    origin,
    destination,
    ...pricing,
    isActive: req.body.isActive !== false,
  }).returning();
  res.status(201).json({ ...created, courierName: agent.name });
});

router.patch("/courier/admin/routes/:id", async (req: Request, res: Response): Promise<void> => {
  if (!canManage(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const id = Number(req.params.id);
  const courierAgentId = Number(req.body.courierAgentId);
  const origin = typeof req.body.origin === "string" ? req.body.origin.trim().slice(0, 200) : "";
  const destination = typeof req.body.destination === "string" ? req.body.destination.trim().slice(0, 200) : "";
  const pricing = parsePricing(req.body);
  if (!Number.isInteger(id) || !Number.isInteger(courierAgentId) || !origin || !destination || origin.toLocaleLowerCase() === destination.toLocaleLowerCase() || !pricing || typeof req.body.isActive !== "boolean") {
    res.status(400).json({ error: "Invalid courier route update" });
    return;
  }
  const corporationId = req.tenant!.corporation.id;
  const [agent] = await db.select().from(courierAgentsTable).where(and(
    eq(courierAgentsTable.id, courierAgentId),
    eq(courierAgentsTable.corporationId, corporationId),
  ));
  if (!agent || (req.body.isActive && !agent.isActive)) {
    res.status(404).json({ error: "Active courier not found" });
    return;
  }
  const [updated] = await db.update(courierRoutesTable).set({
    courierAgentId,
    origin,
    destination,
    ...pricing,
    isActive: req.body.isActive,
  }).where(and(
    eq(courierRoutesTable.id, id),
    eq(courierRoutesTable.corporationId, corporationId),
  )).returning();
  if (!updated) {
    res.status(404).json({ error: "Courier route not found" });
    return;
  }
  res.json({ ...updated, courierName: agent.name });
});

export default router;
