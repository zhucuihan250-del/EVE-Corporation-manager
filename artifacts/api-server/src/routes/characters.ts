import { Router, type IRouter, type Request, type Response } from "express";
import { db, charactersTable, usersTable } from "@workspace/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { getCharacterRetentionDeadline } from "../lib/character-retention";

const router: IRouter = Router();
router.use("/characters", requireAuth, requireTenant);
router.use("/admin/users", requireAuth, requireTenant, requireModule("pap"));

function formatCharacter(c: typeof charactersTable.$inferSelect) {
  return {
    id: c.id,
    userId: c.userId,
    eveCharacterId: c.eveCharacterId,
    eveCharacterName: c.eveCharacterName,
    corporationId: c.corporationId,
    corporationName: c.corporationName,
    isMain: c.isMain,
    deletedAt: c.deletedAt,
    retainedUntil: c.retainedUntil,
    createdAt: c.createdAt,
  };
}

function clearUserSsoIdentity() {
  return {
    corporationJoinedAt: null,
    accessToken: null,
    refreshToken: null,
    tokenExpiry: null,
  };
}

// GET /api/characters - current user's characters
router.get("/characters", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const chars = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.userId, req.session.userId!),
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
      isNull(charactersTable.deletedAt),
    ));

  res.json(chars.map(formatCharacter));
});

// GET /api/characters/all - admin only
router.get("/characters/all", requireAuth, requireModule("pap"), async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const chars = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
      isNull(charactersTable.deletedAt),
    ));

  res.json(chars.map(formatCharacter));
});

// GET /api/admin/users/:id/characters - get all characters for a specific user (admin only)
router.get("/admin/users/:id/characters", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(req.tenant!.membership.role, "admin")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const targetId = typeof req.params.id === "string" ? parseInt(req.params.id, 10) : NaN;
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const chars = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.userId, targetId),
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
      isNull(charactersTable.deletedAt),
    ));

  res.json(chars.map(formatCharacter));
});

// DELETE /api/characters/:id - unlink an active character while retaining site data for 3 months
router.delete("/characters/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const charId = typeof req.params.id === "string" ? parseInt(req.params.id, 10) : NaN;
  if (isNaN(charId)) {
    res.status(400).json({ error: "Invalid character ID" });
    return;
  }

  const [char] = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.id, charId),
      eq(charactersTable.corporationId, req.tenant!.corporation.id),
      isNull(charactersTable.deletedAt),
    ));

  if (!char) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  const isOwner = char.userId === req.session.userId;
  const isAdmin = hasRole(req.tenant!.membership.role, "admin");
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const deletedAt = new Date();
  const retainedUntil = getCharacterRetentionDeadline(deletedAt);
  const previousUserId = char.userId;
  let newMainCharacterId: number | null = null;
  let newMainCharacterName: string | null = null;
  let requiresReauthentication = false;

  await db.transaction(async (tx) => {
    await tx.update(charactersTable).set({
      userId: null,
      isMain: false,
      deletedAt,
      retainedUntil,
    }).where(eq(charactersTable.id, charId));

    if (!char.isMain || !previousUserId) {
      return;
    }

    requiresReauthentication = true;
    const remainingCharacters = await tx
      .select()
      .from(charactersTable)
      .where(and(eq(charactersTable.userId, previousUserId), isNull(charactersTable.deletedAt)))
      .orderBy(asc(charactersTable.createdAt), asc(charactersTable.id));

    await tx
      .update(charactersTable)
      .set({ isMain: false })
      .where(and(eq(charactersTable.userId, previousUserId), isNull(charactersTable.deletedAt)));

    const replacement = remainingCharacters[0];
    if (!replacement) {
      await tx.update(usersTable).set({
        eveCharacterId: null,
        eveCharacterName: null,
        corporationId: null,
        corporationName: null,
        ...clearUserSsoIdentity(),
      }).where(eq(usersTable.id, previousUserId));
      return;
    }

    const [promoted] = await tx
      .update(charactersTable)
      .set({ isMain: true })
      .where(eq(charactersTable.id, replacement.id))
      .returning();

    await tx.update(usersTable).set({
      eveCharacterId: replacement.eveCharacterId,
      eveCharacterName: replacement.eveCharacterName,
      corporationId: replacement.corporationId,
      corporationName: replacement.corporationName,
      ...clearUserSsoIdentity(),
    }).where(eq(usersTable.id, previousUserId));

    newMainCharacterId = promoted?.id ?? replacement.id;
    newMainCharacterName = promoted?.eveCharacterName ?? replacement.eveCharacterName;
  });

  req.log.info(
    {
      charId,
      eveCharacterId: char.eveCharacterId,
      previousUserId,
      removedMain: char.isMain,
      newMainCharacterId,
      retainedUntil,
    },
    "Character unlinked and retained for deletion window",
  );

  res.json({
    success: true,
    removedMain: char.isMain,
    newMainCharacterId,
    newMainCharacterName,
    requiresReauthentication,
  });
});

export default router;
