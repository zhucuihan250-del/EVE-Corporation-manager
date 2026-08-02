import { Router, type IRouter, type Request, type Response } from "express";
import { db, fleetsTable, usersTable, papRecordsTable, charactersTable } from "@workspace/db";
import { eq, desc, sql, inArray, and, isNull } from "drizzle-orm";
import { refreshAccessToken } from "../lib/eve-sso";
import { requireAuth, hasRole } from "../middlewares/auth";
import { ensureBattleReportForFleet, queueBattleReportGeneration } from "../lib/battle-reports";
import { ensureCorporationMembership, hasPermission, requireModule, requireTenant } from "../lib/tenant";
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
router.use("/fleets", requireAuth, requireTenant, requireModule("fleet"));

function canManageFleet(req: Request): boolean {
  return hasRole(req.tenant!.membership.role, "fc") || hasPermission(req.tenant!, "fleet.manage");
}

function normalizeReimbursementRule(value: unknown): (typeof fleetsTable.$inferInsert)["reimbursementRule"] {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new Error("Invalid reimbursement rule");
  const input = value as { description?: unknown; maximumAmount?: unknown; eligibleShips?: unknown };
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 2_000) : "";
  const maximumAmount = input.maximumAmount === null || input.maximumAmount === undefined
    ? null
    : Number(input.maximumAmount);
  if (maximumAmount !== null && (!Number.isFinite(maximumAmount) || maximumAmount < 0)) {
    throw new Error("Invalid reimbursement maximum");
  }
  const eligibleShips = Array.isArray(input.eligibleShips)
    ? input.eligibleShips.slice(0, 200).map((ship) => String(ship).trim().slice(0, 120)).filter(Boolean)
    : [];
  return { description, maximumAmount, eligibleShips };
}

// GET /api/fleets
router.get("/fleets", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const fleets = await db
    .select({
      id: fleetsTable.id,
      corporationId: fleetsTable.corporationId,
      eveFleetId: fleetsTable.eveFleetId,
      name: fleetsTable.name,
      fleetCommander: fleetsTable.fleetCommander,
      papValue: fleetsTable.papValue,
      isActive: fleetsTable.isActive,
      fleetFunction: fleetsTable.fleetFunction,
      reimbursementEnabled: fleetsTable.reimbursementEnabled,
      reimbursementRule: fleetsTable.reimbursementRule,
      startedAt: fleetsTable.startedAt,
      endedAt: fleetsTable.endedAt,
      createdAt: fleetsTable.createdAt,
      participantCount: sql<number>`(
        SELECT COUNT(*)::int FROM "pap_records"
        WHERE "pap_records"."fleet_id" = "fleets"."id"
        AND "pap_records"."type" = 'fleet'
      )`,
      battleReportId: sql<number | null>`(
        SELECT "battle_reports"."id" FROM "battle_reports"
        WHERE "battle_reports"."fleet_id" = "fleets"."id"
        LIMIT 1
      )`,
    })
    .from(fleetsTable)
    .where(eq(fleetsTable.corporationId, req.tenant!.corporation.id))
    .orderBy(desc(fleetsTable.createdAt));

  req.log.info({ fleetParticipantCounts: fleets.map(f => ({ id: f.id, name: f.name, participantCount: f.participantCount })) }, "Fleet list with participant counts");
  res.json(fleets);
});

// POST /api/fleets - admin only
router.post("/fleets", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !canManageFleet(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateFleetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  let reimbursementRule: (typeof fleetsTable.$inferInsert)["reimbursementRule"];
  try {
    reimbursementRule = normalizeReimbursementRule(body.data.reimbursementRule);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Invalid reimbursement rule" });
    return;
  }

  const [fleet] = await db
    .insert(fleetsTable)
    .values({
      corporationId: req.tenant!.corporation.id,
      eveFleetId: body.data.eveFleetId ?? null,
      name: body.data.name,
      fleetCommander: body.data.fleetCommander,
      papValue: body.data.papValue,
      fleetFunction: body.data.fleetFunction?.trim().slice(0, 80) || "general",
      reimbursementEnabled: body.data.reimbursementEnabled === true,
      reimbursementRule,
      startedAt: body.data.startedAt ? new Date(body.data.startedAt) : new Date(),
    })
    .returning();

  res.status(201).json({ ...fleet, participantCount: 0 });
});

// GET /api/fleets/esi-my-fleet - fetch the current user's in-game fleet ID from ESI
// IMPORTANT: must be declared before /fleets/:id so Express doesn't treat "esi-my-fleet" as an id
router.get("/fleets/esi-my-fleet", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  const currentCharacter = req.tenant!.actorCharacter;
  if (!currentUser || !currentCharacter) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  let accessToken = currentCharacter.accessToken;
  if (!accessToken) {
    res.status(400).json({ error: "No ESI access token. Please log in again." });
    return;
  }

  // Refresh token if needed
  const tokenExpiry = currentCharacter.tokenExpiry;
  if (!tokenExpiry || new Date(tokenExpiry.getTime() - 60_000) <= new Date()) {
    if (!currentCharacter.refreshToken) {
      res.status(400).json({ error: "ESI token expired. Please log in again." });
      return;
    }
    try {
      const refreshed = await refreshAccessToken(currentCharacter.refreshToken);
      accessToken = refreshed.accessToken;
      const refreshedValues = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1000),
      };
      await db.update(charactersTable).set(refreshedValues).where(eq(charactersTable.id, currentCharacter.id));
      if (currentCharacter.isMain) {
        await db.update(usersTable).set(refreshedValues).where(eq(usersTable.id, currentUser.id));
      }
    } catch (err) {
      req.log.error({ err }, "Failed to refresh token for esi-my-fleet");
      res.status(400).json({ error: "Token refresh failed. Please log in again." });
      return;
    }
  }

  const esiResp = await fetch(
    `https://esi.evetech.net/latest/characters/${currentCharacter.eveCharacterId}/fleet/?datasource=tranquility`,
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
      corporationId: fleetsTable.corporationId,
      eveFleetId: fleetsTable.eveFleetId,
      name: fleetsTable.name,
      fleetCommander: fleetsTable.fleetCommander,
      papValue: fleetsTable.papValue,
      isActive: fleetsTable.isActive,
      fleetFunction: fleetsTable.fleetFunction,
      reimbursementEnabled: fleetsTable.reimbursementEnabled,
      reimbursementRule: fleetsTable.reimbursementRule,
      startedAt: fleetsTable.startedAt,
      endedAt: fleetsTable.endedAt,
      createdAt: fleetsTable.createdAt,
      participantCount: sql<number>`(
        SELECT COUNT(*)::int FROM "pap_records"
        WHERE "pap_records"."fleet_id" = "fleets"."id"
        AND "pap_records"."type" = 'fleet'
      )`,
      battleReportId: sql<number | null>`(
        SELECT "battle_reports"."id" FROM "battle_reports"
        WHERE "battle_reports"."fleet_id" = "fleets"."id"
        LIMIT 1
      )`,
    })
    .from(fleetsTable)
    .where(and(
      eq(fleetsTable.id, params.data.id),
      eq(fleetsTable.corporationId, req.tenant!.corporation.id),
    ));

  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  res.json(fleet);
});

// PATCH /api/fleets/:id - admin only
router.patch("/fleets/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !canManageFleet(req)) {
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
  if (body.data.isActive === false && body.data.endedAt === undefined) updates.endedAt = new Date();
  if (body.data.eveFleetId !== undefined) updates.eveFleetId = body.data.eveFleetId ?? null;
  if (body.data.fleetFunction !== undefined) updates.fleetFunction = body.data.fleetFunction.trim().slice(0, 80) || "general";
  if (body.data.reimbursementEnabled !== undefined) updates.reimbursementEnabled = body.data.reimbursementEnabled;
  if (body.data.reimbursementRule !== undefined) {
    try {
      updates.reimbursementRule = normalizeReimbursementRule(body.data.reimbursementRule);
    } catch (error) {
      res.status(400).json({ error: error instanceof Error ? error.message : "Invalid reimbursement rule" });
      return;
    }
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: "No fields to update" });
    return;
  }

  const [fleet] = await db
    .update(fleetsTable)
    .set(updates)
    .where(and(
      eq(fleetsTable.id, params.data.id),
      eq(fleetsTable.corporationId, req.tenant!.corporation.id),
    ))
    .returning();

  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  let battleReportId: number | null = null;
  if (!fleet.isActive && fleet.endedAt) {
    battleReportId = await ensureBattleReportForFleet(fleet.id);
    if (battleReportId) queueBattleReportGeneration(battleReportId);
  }

  res.json({ ...fleet, participantCount: null, battleReportId });
});

// POST /api/fleets/:id/scan - scan ESI fleet members and auto-award PAP
// dryRun=true is available to all authenticated users (just returns member count)
// PAP distribution requires admin role
router.post("/fleets/:id/scan", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const dryRun = req.query.dryRun === "true";

  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  const currentCharacter = req.tenant!.actorCharacter;
  if (!currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  if (!dryRun && !canManageFleet(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = GetFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [fleet] = await db.select().from(fleetsTable).where(and(
    eq(fleetsTable.id, params.data.id),
    eq(fleetsTable.corporationId, req.tenant!.corporation.id),
  ));
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

  if (!currentCharacter?.accessToken) {
    res.status(400).json({ error: "No ESI access token. Please log in again." });
    return;
  }

  let accessToken = currentCharacter.accessToken;

  // Refresh token if expired or expiring within 60 seconds
  const tokenExpiry = currentCharacter.tokenExpiry;
  if (!tokenExpiry || new Date(tokenExpiry.getTime() - 60_000) <= new Date()) {
    if (!currentCharacter.refreshToken) {
      res.status(400).json({ error: "ESI token expired. Please log in again." });
      return;
    }
    try {
      const refreshed = await refreshAccessToken(currentCharacter.refreshToken);
      accessToken = refreshed.accessToken;
      const refreshedValues = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        tokenExpiry: new Date(Date.now() + refreshed.expiresIn * 1000),
      };
      await db.update(charactersTable).set(refreshedValues).where(eq(charactersTable.id, currentCharacter.id));
      if (currentCharacter.isMain) {
        await db.update(usersTable).set(refreshedValues).where(eq(usersTable.id, currentUser.id));
      }
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

  // dryRun: only return member count, skip all DB writes
  if (dryRun) {
    res.json({ awarded: 0, skipped: 0, notFound: 0, esiMemberCount: members.length, autoRegistered: 0, dryRun: true });
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
    .where(and(
      inArray(charactersTable.eveCharacterId, memberCharIds),
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
      isNull(charactersTable.deletedAt),
    ));

  req.log.info({ found: characters.length, total: memberCharIds.length }, "Characters found in DB");

  // Auto-register ESI members who haven't logged in yet
  const foundCharIds = new Set(characters.map((c) => c.eveCharacterId));
  const unregisteredCharIds = memberCharIds.filter((id) => !foundCharIds.has(id));
  const autoRegisteredChars: (typeof charactersTable.$inferSelect)[] = [];

  for (const charId of unregisteredCharIds) {
    try {
      // Check if user already exists (handles race conditions)
      const [existingUser] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.eveCharacterId, charId));
      if (existingUser) {
        if (existingUser.corporationId !== req.tenant!.corporation.id) continue;
        const [existingChar] = await db
          .select()
          .from(charactersTable)
          .where(and(
            eq(charactersTable.userId, existingUser.id),
            eq(charactersTable.eveCharacterId, charId),
            isNull(charactersTable.deletedAt),
          ));
        if (existingChar) {
          autoRegisteredChars.push(existingChar);
        } else {
          // User exists in users table but is missing a characters record.
          // Create the missing record so PAP reaches the correct account.
          const [fixedChar] = await db
            .insert(charactersTable)
            .values({
              userId: existingUser.id,
              eveCharacterId: charId,
              eveCharacterName: existingUser.eveCharacterName ?? `Character ${charId}`,
              corporationId: existingUser.corporationId,
              corporationName: existingUser.corporationName ?? "",
              isMain: true,
            })
            .returning();
          autoRegisteredChars.push(fixedChar);
          req.log.info({ charId, userId: existingUser.id }, "Repaired missing characters record for existing user");
        }
        continue;
      }

      // Fetch public character info from ESI (no auth required)
      const esiCharResp = await fetch(
        `https://esi.evetech.net/latest/characters/${charId}/?datasource=tranquility`,
        { headers: { Accept: "application/json" } },
      );
      if (!esiCharResp.ok) {
        req.log.warn({ charId, status: esiCharResp.status }, "ESI public character fetch failed, skipping");
        continue;
      }
      const charInfo = (await esiCharResp.json()) as { name: string; corporation_id?: number };
      if (charInfo.corporation_id !== req.tenant!.corporation.id) continue;

      // Fetch corporation name
      let corpName: string | null = null;
      if (charInfo.corporation_id) {
        const corpResp = await fetch(
          `https://esi.evetech.net/latest/corporations/${charInfo.corporation_id}/?datasource=tranquility`,
          { headers: { Accept: "application/json" } },
        );
        if (corpResp.ok) {
          const corpInfo = (await corpResp.json()) as { name: string };
          corpName = corpInfo.name;
        }
      }

      // Create user record (no tokens — they can log in later to claim their account)
      const [newUser] = await db
        .insert(usersTable)
        .values({
          eveCharacterId: charId,
          eveCharacterName: charInfo.name,
          corporationId: charInfo.corporation_id ?? null,
          corporationName: corpName,
          role: "member",
          totalPap: 0,
          redeemablePap: 0,
        })
        .returning();
      await ensureCorporationMembership(newUser.id, req.tenant!.corporation.id, "member");

      // Create character record
      const [newChar] = await db
        .insert(charactersTable)
        .values({
          userId: newUser.id,
          eveCharacterId: charId,
          eveCharacterName: charInfo.name,
          corporationId: charInfo.corporation_id ?? null,
          corporationName: corpName,
          isMain: true,
        })
        .returning();

      autoRegisteredChars.push(newChar);
      req.log.info({ charId, name: charInfo.name }, "Auto-registered ESI character for PAP");
    } catch (err) {
      req.log.error({ err, charId }, "Failed to auto-register ESI character");
    }
  }

  const allCharacters = [...characters, ...autoRegisteredChars];

  let awarded = 0;
  let skipped = 0;
  const notFound = memberCharIds.length - allCharacters.length;

  for (const character of allCharacters) {
    if (!character.userId) {
      skipped++;
      req.log.warn({ characterId: character.id, eveCharacterId: character.eveCharacterId }, "Skipping active character with no linked user");
      continue;
    }
    if (alreadyAwardedCharIds.has(character.id)) {
      skipped++;
      continue;
    }
    await db.insert(papRecordsTable).values({
      corporationId: req.tenant!.corporation.id,
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

  res.json({ awarded, skipped, notFound, esiMemberCount: members.length, autoRegistered: autoRegisteredChars.length });
});

// DELETE /api/fleets/:id - admin only
router.delete("/fleets/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !canManageFleet(req)) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = DeleteFleetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(fleetsTable).where(and(
    eq(fleetsTable.id, params.data.id),
    eq(fleetsTable.corporationId, req.tenant!.corporation.id),
  ));
  res.sendStatus(204);
});

// POST /api/fleets/:id/participants - add participant and award PAP
router.post("/fleets/:id/participants", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !canManageFleet(req)) {
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

  const [fleet] = await db.select().from(fleetsTable).where(and(
    eq(fleetsTable.id, params.data.id),
    eq(fleetsTable.corporationId, req.tenant!.corporation.id),
  ));
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
    .where(and(
      eq(charactersTable.id, body.data.characterId),
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
      isNull(charactersTable.deletedAt),
    ));

  if (!character?.userId) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  // Award PAP
  const [papRecord] = await db
    .insert(papRecordsTable)
    .values({
      corporationId: req.tenant!.corporation.id,
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
