import { Router, type IRouter, type Request, type Response } from "express";
import { requireAuth } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { searchFittingCatalog, simulateFitting, type FittingCategory, type FittingLanguage, type FittingMode, type FittingSlot } from "../lib/fitting-data";

const router: IRouter = Router();
router.use("/fitting", requireAuth, requireTenant, requireModule("fleet"));

const categories = new Set(["all", "ship", "module", "charge", "drone"]);
const slots = new Set(["all", "high", "medium", "low", "rig", "subsystem", "charge", "drone", "other"]);
const languages = new Set(["en", "zh"]);
const modes = new Set(["pvp", "pve"]);

function queryString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function queryNumber(value: unknown, fallback: number): number {
  const parsed = typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

// GET /api/fitting/catalog - search ships, modules, charges, and drones
router.get("/fitting/catalog", requireAuth, (req: Request, res: Response): void => {
  const languageParam = queryString(req.query.language);
  const categoryParam = queryString(req.query.category);
  const slotParam = queryString(req.query.slot);

  const language = languages.has(languageParam ?? "") ? languageParam as FittingLanguage : "zh";
  const category = categories.has(categoryParam ?? "") ? categoryParam as FittingCategory | "all" : "all";
  const slot = slots.has(slotParam ?? "") ? slotParam as FittingSlot | "all" : "all";

  res.json(searchFittingCatalog({
    query: queryString(req.query.q),
    language,
    category,
    slot,
    limit: queryNumber(req.query.limit, 50),
  }));
});

// POST /api/fitting/simulate - approximate fitting checks and PVP/PVE guidance
router.post("/fitting/simulate", requireAuth, (req: Request, res: Response): void => {
  const body = req.body as {
    shipId?: unknown;
    modules?: unknown;
    mode?: unknown;
    language?: unknown;
  };
  const shipId = typeof body.shipId === "number" ? body.shipId : Number(body.shipId);
  if (!Number.isFinite(shipId)) {
    res.status(400).json({ error: "Invalid ship ID" });
    return;
  }

  const moduleInputs = Array.isArray(body.modules)
    ? body.modules.map((entry) => {
      const value = entry as { typeId?: unknown; quantity?: unknown };
      return {
        typeId: typeof value.typeId === "number" ? value.typeId : Number(value.typeId),
        quantity: value.quantity === undefined ? 1 : Number(value.quantity),
      };
    }).filter((entry) => Number.isFinite(entry.typeId))
    : [];
  const mode = modes.has(String(body.mode)) ? body.mode as FittingMode : "pvp";
  const language = languages.has(String(body.language)) ? body.language as FittingLanguage : "zh";

  try {
    res.json(simulateFitting({
      shipId,
      modules: moduleInputs,
      mode,
      language,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Simulation failed";
    res.status(message === "Ship not found" ? 404 : 400).json({ error: message });
  }
});

export default router;
