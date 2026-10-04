import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { getFittingCatalogItem, searchFittingCatalog } from "../lib/fitting-data";
import { validateCanonicalFit, resolveWorkbenchFit, simulateWorkbench, parseEft, exportEft, FittingInputError } from "../lib/fitting-engine";
import { createFittingSkillsService } from "../lib/fitting-workbench-skills";
import { createFittingWorkbenchService } from "../lib/fitting-workbench-service";
import { createFittingWorkbenchRouter } from "../lib/fitting-workbench-router";
import { createFittingAdviceService } from "../lib/fitting-advice-service";
import { createOpenAiFittingAdviceProvider } from "../lib/fitting-advice-provider";
import { quoteFits } from "../lib/fitting-advice-prices";

const engine = { validateCanonicalFit, resolveWorkbenchFit, simulateWorkbench, parseEft, exportEft };
const workbench = createFittingWorkbenchService({ database: db, engine, skills: createFittingSkillsService({ database: db }) });
export default createFittingWorkbenchRouter({
  service: workbench,
  adviceService: createFittingAdviceService({ engine, resolveSkills: workbench.resolveSkillContext, provider: createOpenAiFittingAdviceProvider(), quoteFits }),
  requireAuth,
  requireTenant,
  requireFleet: requireModule("fleet"),
  searchCatalog: searchFittingCatalog,
  getCatalogItem: getFittingCatalogItem,
  isEngineInputError: (error): error is FittingInputError => error instanceof FittingInputError,
});
