import { Router, type IRouter, type Request, type Response } from "express";
import { db, charactersTable, usersTable, papRecordsTable } from "@workspace/db";
import { eq, count, sum, sql } from "drizzle-orm";
import { requireAuth } from "../middlewares/auth";

const router: IRouter = Router();

// GET /api/characters - current user's characters
router.get("/characters", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const chars = await db
    .select()
    .from(charactersTable)
    .where(eq(charactersTable.userId, req.session.userId!));

  res.json(chars.map(c => ({
    id: c.id,
    userId: c.userId,
    eveCharacterId: c.eveCharacterId,
    eveCharacterName: c.eveCharacterName,
    corporationId: c.corporationId,
    corporationName: c.corporationName,
    isMain: c.isMain,
    createdAt: c.createdAt,
  })));
});

// GET /api/characters/all - admin only
router.get("/characters/all", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const chars = await db.select().from(charactersTable);
  res.json(chars.map(c => ({
    id: c.id,
    userId: c.userId,
    eveCharacterId: c.eveCharacterId,
    eveCharacterName: c.eveCharacterName,
    corporationId: c.corporationId,
    corporationName: c.corporationName,
    isMain: c.isMain,
    createdAt: c.createdAt,
  })));
});

// GET /api/admin/users/:id/characters - get all characters for a specific user (admin only)
router.get("/admin/users/:id/characters", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const targetId = parseInt(req.params.id, 10);
  if (isNaN(targetId)) {
    res.status(400).json({ error: "Invalid user ID" });
    return;
  }

  const chars = await db
    .select()
    .from(charactersTable)
    .where(eq(charactersTable.userId, targetId));

  res.json(chars.map(c => ({
    id: c.id,
    userId: c.userId,
    eveCharacterId: c.eveCharacterId,
    eveCharacterName: c.eveCharacterName,
    corporationId: c.corporationId,
    corporationName: c.corporationName,
    isMain: c.isMain,
    createdAt: c.createdAt,
  })));
});

// DELETE /api/characters/:id - admin only, remove a character record
router.delete("/characters/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || currentUser.role !== "admin") {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const charId = parseInt(req.params.id, 10);
  if (isNaN(charId)) {
    res.status(400).json({ error: "Invalid character ID" });
    return;
  }

  const [char] = await db.select().from(charactersTable).where(eq(charactersTable.id, charId));
  if (!char) {
    res.status(404).json({ error: "Character not found" });
    return;
  }

  // Sum PAP earned by this character before deleting
  const [papSum] = await db
    .select({ total: sum(papRecordsTable.amount) })
    .from(papRecordsTable)
    .where(eq(papRecordsTable.characterId, charId));
  const papToDeduct = Number(papSum?.total ?? 0);

  // Delete all PAP records for this character
  await db.delete(papRecordsTable).where(eq(papRecordsTable.characterId, charId));

  // Subtract from user's PAP balance (clamp both values to 0)
  if (papToDeduct > 0) {
    await db.update(usersTable).set({
      totalPap: sql`GREATEST(0, total_pap - ${papToDeduct})`,
      redeemablePap: sql`GREATEST(0, redeemable_pap - ${papToDeduct})`,
    }).where(eq(usersTable.id, char.userId));
  }

  // Delete the character record
  await db.delete(charactersTable).where(eq(charactersTable.id, charId));
  req.log.info({ charId, eveCharacterId: char.eveCharacterId, userId: char.userId, papDeducted: papToDeduct }, "Admin hard-deleted character and all its PAP records");

  // If user has no characters left and is an orphan (no accessToken), remove from roster
  const [remaining] = await db.select({ total: count() }).from(charactersTable).where(eq(charactersTable.userId, char.userId));
  if ((remaining?.total ?? 0) === 0) {
    const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, char.userId));
    if (owner && !owner.accessToken) {
      await db.delete(usersTable).where(eq(usersTable.id, char.userId));
      req.log.info({ userId: char.userId }, "Removed orphan user after last character was deleted");
    }
  }

  res.json({ success: true });
});

export default router;
