import { Router, type IRouter, type Request, type Response } from "express";
import { corporationMembershipsTable, db, papRecordsTable, usersTable, fleetsTable, charactersTable } from "@workspace/db";
import { and, eq, desc, sql } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import { CreateManualPapBody } from "@workspace/api-zod";
import { requireModule, requireTenant } from "../lib/tenant";
import { canonicalPapBalance, normalizePap, setPapBalance } from "../lib/pap-balance";

const router: IRouter = Router();
router.use("/pap", requireAuth, requireTenant, requireModule("pap"));

function formatRecord(r: {
  id: number;
  userId: number;
  characterId: number | null;
  fleetId: number | null;
  amount: number;
  type: string;
  reason: string | null;
  createdAt: Date;
  fleetName?: string | null;
  characterName?: string | null;
  userName?: string | null;
}) {
  return {
    id: r.id,
    userId: r.userId,
    characterId: r.characterId,
    fleetId: r.fleetId,
    amount: r.amount,
    type: r.type,
    reason: r.reason,
    fleetName: r.fleetName ?? null,
    characterName: r.characterName ?? null,
    userName: r.userName ?? null,
    createdAt: r.createdAt,
  };
}

// GET /api/pap - current user's PAP records
router.get("/pap", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const records = await db
    .select({
      id: papRecordsTable.id,
      userId: papRecordsTable.userId,
      characterId: papRecordsTable.characterId,
      fleetId: papRecordsTable.fleetId,
      amount: papRecordsTable.amount,
      type: papRecordsTable.type,
      reason: papRecordsTable.reason,
      createdAt: papRecordsTable.createdAt,
      fleetName: fleetsTable.name,
      characterName: charactersTable.eveCharacterName,
      userName: sql<string | null>`(
        SELECT c."eve_character_name" FROM "characters" c
        WHERE c."user_id" = ${papRecordsTable.userId}
          AND c."corporation_id" = ${req.tenant!.corporation.id}
          AND c."deleted_at" IS NULL
        ORDER BY c."is_main" DESC, c."created_at" ASC LIMIT 1
      )`,
    })
    .from(papRecordsTable)
    .leftJoin(fleetsTable, eq(papRecordsTable.fleetId, fleetsTable.id))
    .leftJoin(charactersTable, and(
      eq(papRecordsTable.characterId, charactersTable.id),
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
    ))
    .where(and(
      eq(papRecordsTable.userId, req.session.userId!),
      eq(papRecordsTable.corporationId, req.tenant!.corporation.id),
    ))
    .orderBy(desc(papRecordsTable.createdAt));

  res.json(records.map(formatRecord));
});

// GET /api/pap/all - admin only
router.get("/pap/all", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const records = await db
    .select({
      id: papRecordsTable.id,
      userId: papRecordsTable.userId,
      characterId: papRecordsTable.characterId,
      fleetId: papRecordsTable.fleetId,
      amount: papRecordsTable.amount,
      type: papRecordsTable.type,
      reason: papRecordsTable.reason,
      createdAt: papRecordsTable.createdAt,
      fleetName: fleetsTable.name,
      characterName: charactersTable.eveCharacterName,
      userName: sql<string | null>`(
        SELECT c."eve_character_name" FROM "characters" c
        WHERE c."user_id" = ${papRecordsTable.userId}
          AND c."corporation_id" = ${req.tenant!.corporation.id}
          AND c."deleted_at" IS NULL
        ORDER BY c."is_main" DESC, c."created_at" ASC LIMIT 1
      )`,
    })
    .from(papRecordsTable)
    .leftJoin(fleetsTable, eq(papRecordsTable.fleetId, fleetsTable.id))
    .leftJoin(charactersTable, and(
      eq(papRecordsTable.characterId, charactersTable.id),
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
    ))
    .where(eq(papRecordsTable.corporationId, req.tenant!.corporation.id))
    .orderBy(desc(papRecordsTable.createdAt));

  res.json(records.map(formatRecord));
});

// POST /api/pap/manual - admin only
router.post("/pap/manual", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateManualPapBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [targetUser] = await db
    .select({ user: usersTable })
    .from(corporationMembershipsTable)
    .innerJoin(usersTable, eq(usersTable.id, corporationMembershipsTable.userId))
    .where(and(
      eq(corporationMembershipsTable.corporationId, req.tenant!.corporation.id),
      eq(corporationMembershipsTable.userId, body.data.userId),
    ));
  if (!targetUser) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const papRecord = await db.transaction(async (tx) => {
    const [lockedUser] = await tx
      .select({ id: usersTable.id, redeemablePap: usersTable.redeemablePap })
      .from(usersTable)
      .where(eq(usersTable.id, body.data.userId))
      .for("update");
    if (!lockedUser) throw new Error(`Manual PAP target ${body.data.userId} no longer exists`);

    const before = canonicalPapBalance(lockedUser.redeemablePap);
    const after = canonicalPapBalance(before + body.data.amount);
    const appliedAmount = normalizePap(after - before);

    await tx.update(usersTable)
      .set(setPapBalance(after))
      .where(eq(usersTable.id, lockedUser.id));

    const [record] = await tx
      .insert(papRecordsTable)
      .values({
        corporationId: req.tenant!.corporation.id,
        userId: lockedUser.id,
        amount: appliedAmount,
        type: "manual",
        reason: body.data.reason,
      })
      .returning();
    return record;
  });

  res.status(201).json({
    ...papRecord,
    fleetName: null,
    characterName: null,
    userName: targetUser.user.eveCharacterName,
  });
});

export default router;
