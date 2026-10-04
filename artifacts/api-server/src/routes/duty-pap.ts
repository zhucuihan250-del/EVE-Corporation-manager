import { requireAuth } from "../middlewares/auth";
import { requireModule, requireTenant } from "../lib/tenant";
import { createDutyPapRouter } from "../lib/duty-pap-router";
import { dutyPapService } from "../lib/duty-pap";
export default createDutyPapRouter({ service: dutyPapService, requireAuth, requireTenant, requirePap: requireModule("pap"), requireFleet: requireModule("fleet") });
