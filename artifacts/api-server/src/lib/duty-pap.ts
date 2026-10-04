import { db } from "@workspace/db";
import { getTenantContext } from "./tenant";
import { createDutyPapService } from "./duty-pap-service";
import { createDutyPapOAuthHandlers, createDutyPapOAuthProvider } from "./duty-pap-oauth";
export const dutyPapService = createDutyPapService({ database: db });
export const dutyPapOAuth = createDutyPapOAuthHandlers({ database: db, service: dutyPapService, provider: createDutyPapOAuthProvider(), getTenant: getTenantContext });
