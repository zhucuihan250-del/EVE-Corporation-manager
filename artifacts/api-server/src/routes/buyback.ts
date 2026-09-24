import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { requireTenant } from "../lib/tenant";
import { getBuybackTarget, resolveBuybackTypes, searchBuybackCatalog } from "../lib/buyback-catalog";
import { getBuybackMarketPrices } from "../lib/buyback-market";
import { createBuybackService } from "../lib/buyback-service";
import { createBuybackRouter } from "../lib/buyback-router";

export default createBuybackRouter({
  service: createBuybackService({ database: db, resolveTypes: resolveBuybackTypes, getTarget: getBuybackTarget, getPrices: getBuybackMarketPrices }),
  requireAuth,
  requireTenant,
  searchCatalog: searchBuybackCatalog,
});
