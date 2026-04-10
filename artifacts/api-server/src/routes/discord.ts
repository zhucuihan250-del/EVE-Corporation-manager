import { Router, type IRouter, type Request, type Response } from "express";
import { db, fleetsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { z } from "zod/v4";

const router: IRouter = Router();

function getSecret(): string {
  return process.env.DISCORD_WEBHOOK_SECRET ?? "";
}

const PingBody = z.object({
  secret: z.string(),
  name: z.string(),
  fleetCommander: z.string(),
  pingType: z.string().optional().default("Other"),
  papValue: z.number().optional().default(1),
  scheduledAt: z.string().nullable().optional(),
  discordMessageId: z.string().nullable().optional(),
});

const SecretBody = z.object({
  secret: z.string(),
});

const IdParam = z.object({
  id: z.coerce.number().int().positive(),
});

router.post("/discord/ping", async (req: Request, res: Response): Promise<void> => {
  const body = PingBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const secret = getSecret();
  if (!secret || body.data.secret !== secret) {
    res.status(403).json({ error: "Invalid secret" });
    return;
  }

  const scheduledAt = body.data.scheduledAt ? new Date(body.data.scheduledAt) : null;

  const [fleet] = await db
    .insert(fleetsTable)
    .values({
      name: body.data.name,
      fleetCommander: body.data.fleetCommander,
      pingType: body.data.pingType,
      papValue: body.data.papValue,
      status: "pending",
      isActive: false,
      scheduledAt,
      discordMessageId: body.data.discordMessageId ?? null,
    })
    .returning();

  res.status(201).json({ ...fleet, participantCount: 0 });
});

router.post("/discord/start/:id", async (req: Request, res: Response): Promise<void> => {
  const params = IdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const body = SecretBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const secret = getSecret();
  if (!secret || body.data.secret !== secret) {
    res.status(403).json({ error: "Invalid secret" });
    return;
  }

  const [fleet] = await db
    .update(fleetsTable)
    .set({ status: "active", isActive: true, startedAt: new Date() })
    .where(eq(fleetsTable.id, params.data.id))
    .returning();

  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  res.json({ ...fleet, participantCount: null });
});

router.post("/discord/end/:id", async (req: Request, res: Response): Promise<void> => {
  const params = IdParam.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }

  const body = SecretBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const secret = getSecret();
  if (!secret || body.data.secret !== secret) {
    res.status(403).json({ error: "Invalid secret" });
    return;
  }

  const [fleet] = await db
    .update(fleetsTable)
    .set({ status: "finished", isActive: false, endedAt: new Date() })
    .where(eq(fleetsTable.id, params.data.id))
    .returning();

  if (!fleet) {
    res.status(404).json({ error: "Fleet not found" });
    return;
  }

  res.json({ ...fleet, participantCount: null });
});

export default router;
