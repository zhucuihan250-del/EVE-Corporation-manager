import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { getFittingCatalogItem, searchFittingCatalog } from "../lib/fitting-data";
import { validateCanonicalFit, resolveWorkbenchFit, simulateWorkbench, parseEft, exportEft, FittingInputError } from "../lib/fitting-engine";
import { createFittingSkillsService } from "../lib/fitting-workbench-skills";
import { createFittingWorkbenchService } from "../lib/fitting-workbench-service";
import { createFittingWorkbenchRouter } from "../lib/fitting-workbench-router";

export default createFittingWorkbenchRouter({
  service: createFittingWorkbenchService({
    database: db,
    engine: { validateCanonicalFit, resolveWorkbenchFit, simulateWorkbench, parseEft, exportEft },
    skills: createFittingSkillsService({ database: db }),
  }),
  requireAuth,
  requireTenant,
  requireFleet: requireModule("fleet"),
  searchCatalog: searchFittingCatalog,
  getCatalogItem: getFittingCatalogItem,
  isEngineInputError: (error): error is FittingInputError => error instanceof FittingInputError,
});
