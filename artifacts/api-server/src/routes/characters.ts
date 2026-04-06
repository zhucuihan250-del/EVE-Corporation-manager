import { Router, type IRouter, type Request, type Response } from "express";
import { db, charactersTable, usersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
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

export default router;
