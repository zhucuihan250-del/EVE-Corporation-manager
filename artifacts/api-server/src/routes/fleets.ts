import { Router, type IRouter, type Request, type Response } from "express";
import { db, fleetsTable, usersTable, papRecordsTable, charactersTable } from "@workspace/db";
import { eq, desc, sql, inArray } from "drizzle-orm";
import { refreshAccessToken } from "../lib/eve-sso";
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

// GET /api/fleets/esi-my-fleet - fetch the current user's in-game fleet ID from ESI
// IMPORTANT: must be declared before /fleets/:id so Express doesn't treat "esi-my-fleet" as an id
router.get("/fleets/esi-my-fleet", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  if (!currentUser.eveCharacterId) {
    res.status(400).json({ error: "No EVE character linked" });
    return;
  }

  let accessToken = currentUser.accessToken;
  if (!accessToken) {
    res.status(400).json({ error: "No ESI access token. Please log in again." });
    return;
  }

  // Refresh token if needed
  const tokenExpiry = currentUser.tokenExpiry;
  if (!tokenExpiry || new Date(tokenExpiry.getTime() - 60_000) <= new Date()) {
    if (!currentUser.refreshToken) {
      res.status(400).json({ error: "ESI token expired. Please log in again." });
      return;
    }
    try {
      const refreshed = await refreshAccessToken(currentUser.refreshToken);
      accessToken = refreshed.accessToken;
      await db.update(usersTable).set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1000),
      }).where(eq(usersTable.id, currentUser.id));
    } catch (err) {
      req.log.error({ err }, "Failed to refresh token for esi-my-fleet");
      res.status(400).json({ error: "Token refresh failed. Please log in again." });
      return;
    }
  }

  const esiResp = await fetch(
    `https://esi.evetech.net/latest/characters/${currentUser.eveCharacterId}/fleet/?datasource=tranquility`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
  );

  if (!esiResp.ok) {
    if (esiResp.status === 404) {
      res.status(404).json({ error: "You are not currently in a fleet in-game." });
    } else {
      const text = await esiResp.text();
      req.log.error({ status: esiResp.status, body: text }, "ESI character fleet fetch failed");
      res.status(502).json({ error: "ESI error: " + text });
    }
    return;
  }

  const data = (await esiResp.json()) as {
    fleet_id: number;
    role: string;
    squad_id: number;
    wing_id: number;
  };

  req.log.info({ fleetId: data.fleet_id, role: data.role }, "ESI fleet ID fetched for character");
  res.json({ fleetId: String(data.fleet_id), role: data.role });
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
  if (body.data.eveFleetId !== undefined) updates.eveFleetId = body.data.eveFleetId ?? null;

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

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

// POST /api/fleets/:id/scan - scan ESI fleet members and auto-award PAP
router.post("/fleets/:id/scan", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = GetFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [fleet] = await db.select().from(fleetsTable).where(eq(fleetsTable.id, params.data.id));
  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  if (!fleet.eveFleetId) {
    res.status(400).json({ error: "Fleet has no EVE fleet ID set" });
    return;
  }

  if (!fleet.isActive) {
    res.status(400).json({ error: "Fleet is not active" });
    return;
  }

  if (!currentUser.accessToken) {
    res.status(400).json({ error: "No ESI access token. Please log in again." });
    return;
  }

  let accessToken = currentUser.accessToken;

  // Refresh token if expired or expiring within 60 seconds
  const tokenExpiry = currentUser.tokenExpiry;
  if (!tokenExpiry || new Date(tokenExpiry.getTime() - 60_000) <= new Date()) {
    if (!currentUser.refreshToken) {
      res.status(400).json({ error: "ESI token expired. Please log in again." });
      return;
    }
    try {
      const refreshed = await refreshAccessToken(currentUser.refreshToken);
      accessToken = refreshed.accessToken;
      await db
        .update(usersTable)
        .set({
          accessToken: refreshed.accessToken,
          refreshToken: refreshed.refreshToken,
          tokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1000),
        })
        .where(eq(usersTable.id, currentUser.id));
      req.log.info("ESI access token refreshed for fleet scan");
    } catch (refreshErr) {
      req.log.error({ err: refreshErr }, "Failed to refresh ESI token");
      res.status(400).json({ error: "ESI token expired and refresh failed. Please log in again." });
      return;
    }
  }

  const esiResp = await fetch(
    `https://esi.evetech.net/latest/fleets/${fleet.eveFleetId}/members/?datasource=tranquility`,
    { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
  );

  if (!esiResp.ok) {
    const text = await esiResp.text();
    req.log.error({ status: esiResp.status, body: text }, "ESI fleet members fetch failed");
    let message = "Failed to fetch fleet members from ESI.";
    if (esiResp.status === 404) {
      message = "Fleet not found on ESI. Make sure the EVE Fleet ID is correct and you are the fleet boss in-game.";
    } else if (esiResp.status === 403) {
      message = "ESI access denied. You must be the fleet boss to scan members.";
    }
    res.status(502).json({ error: message });
    return;
  }

  const members = (await esiResp.json()) as { character_id: number }[];
  req.log.info({ esiMemberCount: members.length, fleetId: fleet.id }, "ESI fleet members fetched");

  if (!members.length) {
    res.json({ awarded: 0, skipped: 0, notFound: 0, esiMemberCount: 0 });
    return;
  }

  const existingPaps = await db
    .select({ characterId: papRecordsTable.characterId })
    .from(papRecordsTable)
    .where(eq(papRecordsTable.fleetId, fleet.id));

  const alreadyAwardedCharIds = new Set(existingPaps.map((p) => p.characterId));
  const memberCharIds = members.map((m) => m.character_id);

  req.log.info({ memberCharIds, esiMemberCount: memberCharIds.length }, "Looking up ESI character IDs in DB");

  const characters = await db
    .select()
    .from(charactersTable)
    .where(inArray(charactersTable.eveCharacterId, memberCharIds));

  req.log.info({ found: characters.length, total: memberCharIds.length }, "Characters found in DB");

  let awarded = 0;
  let skipped = 0;
  const notFound = memberCharIds.length - characters.length;

  for (const character of characters) {
    if (alreadyAwardedCharIds.has(character.id)) {
      skipped++;
      continue;
    }
    await db.insert(papRecordsTable).values({
      userId: character.userId,
      characterId: character.id,
      fleetId: fleet.id,
      amount: fleet.papValue,
      type: "fleet",
      reason: `Fleet: ${fleet.name}`,
    });
    await db
      .update(usersTable)
      .set({
        totalPap: sql`total_pap + ${fleet.papValue}`,
        redeemablePap: sql`redeemable_pap + ${fleet.papValue}`,
      })
      .where(eq(usersTable.id, character.userId));
    awarded++;
  }

  res.json({ awarded, skipped, notFound, esiMemberCount: members.length });
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
