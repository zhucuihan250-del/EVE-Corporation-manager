import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { createPapCurrencyService } from "../lib/pap-currency-service";
import { createPapCurrencyRouter } from "../lib/pap-currency-router";

export default createPapCurrencyRouter({ service: createPapCurrencyService({ database: db }), requireAuth, requireTenant, requirePap: requireModule("pap") });
