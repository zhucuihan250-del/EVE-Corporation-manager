import { db } from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { requireTenant } from "../lib/tenant";
import { createForumRouter } from "../lib/forum-router";
import { createForumService } from "../lib/forum-service";

export default createForumRouter({ service: createForumService({ database: db }), requireAuth, requireTenant });
