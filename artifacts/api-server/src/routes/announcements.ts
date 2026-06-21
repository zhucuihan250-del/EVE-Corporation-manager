import { Router, type IRouter, type Request, type Response } from "express";
import { db, announcementsTable, usersTable } from "@workspace/db";
import { eq, asc } from "drizzle-orm";
import { CreateAnnouncementBody, DeleteAnnouncementParams } from "@workspace/api-zod";
import { requireAuth, hasRole } from "../middlewares/auth";

const router: IRouter = Router();

function formatAnnouncement(a: typeof announcementsTable.$inferSelect) {
  return {
    id: a.id,
    fc: a.fc,
    scheduledAt: a.scheduledAt,
    rallyPoint: a.rallyPoint,
    rallyLevel: a.rallyLevel,
    notes: a.notes ?? null,
    createdAt: a.createdAt,
  };
}

// GET /api/announcements - list all announcements (all authenticated users)
router.get("/announcements", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const announcements = await db
    .select()
    .from(announcementsTable)
    .orderBy(asc(announcementsTable.scheduledAt));
  res.json(announcements.map(formatAnnouncement));
});

// POST /api/announcements - create announcement (admin only)
router.post("/announcements", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "fc")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const body = CreateAnnouncementBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [announcement] = await db
    .insert(announcementsTable)
    .values({
      fc: body.data.fc,
      scheduledAt: new Date(body.data.scheduledAt),
      rallyPoint: body.data.rallyPoint,
      rallyLevel: body.data.rallyLevel,
      notes: body.data.notes ?? null,
    })
    .returning();

  res.status(201).json(formatAnnouncement(announcement));
});

// DELETE /api/announcements/:id - delete announcement (admin only)
router.delete("/announcements/:id", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [currentUser] = await db.select().from(usersTable).where(eq(usersTable.id, req.session.userId!));
  if (!currentUser || !hasRole(currentUser.role, "fc")) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }

  const params = DeleteAnnouncementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  await db.delete(announcementsTable).where(eq(announcementsTable.id, params.data.id));
  res.status(204).send();
});

export default router;
