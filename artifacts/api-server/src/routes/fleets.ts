import { Router, type IRouter, type Request, type Response } from "express";
import { db, fleetsTable, usersTable, papRecordsTable, charactersTable } from "@workspace/db";
import { eq, desc, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";
import {
  CreateFleetBody,
  GetFleetParams,
  UpdateFleetParams,
  UpdateFleetBody,
  DeleteFleetParams,
  AddFleetParticipantParams,
  AddFleetParticipantBody,
} from "@workspace/api-zod";

const router: IRouter = Router();

// GET /api/fleets
router.get("/fleets", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const fleets = await db
    .select({
      id: fleetsTable.id,
      eveFleetId: fleetsTable.eveFleetId,
      name: fleetsTable.name,
      fleetCommander: fleetsTable.fleetCommander,
      papValue: fleetsTable.papValue,
      isActive: fleetsTable.isActive,
      startedAt: fleetsTable.startedAt,
      endedAt: fleetsTable.endedAt,
      createdAt: fleetsTable.createdAt,
      participantCount: sql<number>`(
        SELECT COUNT(*) FROM pap_records
        WHERE fleet_id = ${fleetsTable.id} AND type = 'fleet'
      )`,
    })
    .from(fleetsTable)
    .orderBy(desc(fleetsTable.createdAt));

  res.json(fleets);
});

// POST /api/fleets - admin only
router.post("/fleets", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateFleetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [fleet] = await db
    .insert(fleetsTable)
    .values({
      eveFleetId: body.data.eveFleetId ?? null,
      name: body.data.name,
      fleetCommander: body.data.fleetCommander,
      papValue: body.data.papValue,
      startedAt: body.data.startedAt ? new Date(body.data.startedAt) : new Date(),
    })
    .returning();

  res.status(201).json({ ...fleet, participantCount: 0 });
});

// GET /api/fleets/:id
router.get("/fleets/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const params = GetFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [fleet] = await db
    .select({
      id: fleetsTable.id,
      eveFleetId: fleetsTable.eveFleetId,
      name: fleetsTable.name,
      fleetCommander: fleetsTable.fleetCommander,
      papValue: fleetsTable.papValue,
      isActive: fleetsTable.isActive,
      startedAt: fleetsTable.startedAt,
      endedAt: fleetsTable.endedAt,
      createdAt: fleetsTable.createdAt,
      participantCount: sql<number>`(
        SELECT COUNT(*) FROM pap_records
        WHERE fleet_id = ${fleetsTable.id} AND type = 'fleet'
      )`,
    })
    .from(fleetsTable)
    .where(eq(fleetsTable.id, params.data.id));

  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  res.json(fleet);
});

// PATCH /api/fleets/:id - admin only
router.patch("/fleets/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = UpdateFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateFleetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const updates: Partial<typeof fleetsTable.$inferInsert> = {};
  if (body.data.name !== undefined) updates.name = body.data.name;
  if (body.data.fleetCommander !== undefined) updates.fleetCommander = body.data.fleetCommander;
  if (body.data.papValue !== undefined) updates.papValue = body.data.papValue;
  if (body.data.isActive !== undefined) updates.isActive = body.data.isActive;
  if (body.data.endedAt !== undefined) updates.endedAt = body.data.endedAt ? new Date(body.data.endedAt) : null;

  const [fleet] = await db
    .update(fleetsTable)
    .set(updates)
    .where(eq(fleetsTable.id, params.data.id))
    .returning();

  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  res.json({ ...fleet, participantCount: null });
});

// DELETE /api/fleets/:id - admin only
router.delete("/fleets/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = DeleteFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(fleetsTable).where(eq(fleetsTable.id, params.data.id));
  res.sendStatus(204);
});

// POST /api/fleets/:id/participants - add participant and award PAP
router.post("/fleets/:id/participants", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = AddFleetParticipantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = AddFleetParticipantBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [fleet] = await db.select().from(fleetsTable).where(eq(fleetsTable.id, params.data.id));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  if (!fleet.isActive) {
    res.status(400).json({ error: "Fleet is not active" });
    return;
  }

  const [character] = await db
    .select()
    .from(charactersTable)
    .where(eq(charactersTable.id, body.data.characterId));

  if (!character) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  // Award PAP
  const [papRecord] = await db
    .insert(papRecordsTable)
    .values({
      userId: character.userId,
      characterId: character.id,
      fleetId: fleet.id,
      amount: fleet.papValue,
      type: "fleet",
      reason: `Fleet: ${fleet.name}`,
    })
    .returning();

  // Update user totals
  await db
    .update(usersTable)
    .set({
      totalPap: sql`total_pap + ${fleet.papValue}`,
      redeemablePap: sql`redeemable_pap + ${fleet.papValue}`,
    })
    .where(eq(usersTable.id, character.userId));

  res.status(201).json({
    ...papRecord,
    fleetName: fleet.name,
    characterName: character.eveCharacterName,
    userName: null,
  });
});

export default router;
