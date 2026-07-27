import { Router, type IRouter, type Request, type Response } from "express";
import { db, charactersTable, usersTable } from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { requireAuth, hasRole } from "../middlewares/auth";
import { getCharacterRetentionDeadline } from "../lib/character-retention";

const router: IRouter = Router();

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

// GET /api/characters - current user's characters
router.get("/characters", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const chars = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.userId, req.session.userId!), isNull(charactersTable.deletedAt)));

  res.json(chars.map(formatCharacter));
});

// GET /api/characters/all - admin only
router.get("/characters/all", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const chars = await db
    .select()
    .from(charactersTable)
    .where(isNull(charactersTable.deletedAt));

  res.json(chars.map(formatCharacter));
});

// GET /api/admin/users/:id/characters - get all characters for a specific user (admin only)
router.get("/admin/users/:id/characters", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
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
    .where(and(eq(charactersTable.userId, targetId), isNull(charactersTable.deletedAt)));

  res.json(chars.map(formatCharacter));
});

// DELETE /api/characters/:id - unlink an active non-main character while retaining site data for 3 months
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
    .where(and(eq(charactersTable.id, charId), isNull(charactersTable.deletedAt)));

  if (!char) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  const isOwner = char.userId === req.session.userId;
  const isAdmin = hasRole(currentUser.role, "admin");
  if (!isOwner && !isAdmin) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  if (char.isMain) {
    res.status(400).json({ error: "Main character cannot be unlinked. Delete the user account instead." });
    return;
  }

  const deletedAt = new Date();
  const retainedUntil = getCharacterRetentionDeadline(deletedAt);
  await db.update(charactersTable).set({
    userId: null,
    isMain: false,
    deletedAt,
    retainedUntil,
  }).where(eq(charactersTable.id, charId));

  req.log.info(
    { charId, eveCharacterId: char.eveCharacterId, previousUserId: char.userId, retainedUntil },
    "Character unlinked and retained for deletion window",
  );

  res.json({ success: true });
});

export default router;
