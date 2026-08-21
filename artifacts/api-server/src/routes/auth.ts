import { Router, type IRouter, type Request, type Response } from "express";
import {
  corporationRosterConnectionsTable,
  corporationStructureConnectionsTable,
  corporationWalletConnectionsTable,
  corporationMembershipsTable,
  db,
  usersTable,
  charactersTable,
  papRecordsTable,
  papLedgerTable,
  papMarketAdminLogsTable,
  papMarketOrdersTable,
  papMarketTransactionsTable,
  identityGroupMembershipsTable,
  identityGroupsTable,
} from "@workspace/db";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { generateOauthState, getAuthorizationUrl, getLinkAltAuthorizationUrl, exchangeCode, getCharacterInfo, getCorporationName } from "../lib/eve-sso";
import { hasRole, requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { getCorporationJoinDate } from "../lib/corporation-membership";
import {
  ensureCorporation,
  ensureCorporationMembership,
  getTenantContext,
} from "../lib/tenant";
import { timingSafeEqual } from "node:crypto";
import { availablePap, incrementPapBalance } from "../lib/pap-balance";

const router: IRouter = Router();

/** Transfer all PAP + character records from an orphan user into a main account, then delete the orphan. */
async function mergeOrphanUser(
  orphan: typeof usersTable.$inferSelect | null,
  mainUserId: number,
  log: { info: (obj: object, msg: string) => void },
): Promise<void> {
  if (!orphan) return;
  const memberships = await db
    .select()
    .from(corporationMembershipsTable)
    .where(eq(corporationMembershipsTable.userId, orphan.id));
  if (memberships.length > 0) {
    await db.insert(corporationMembershipsTable).values(memberships.map((membership) => ({
      corporationId: membership.corporationId,
      userId: mainUserId,
      role: membership.role,
    }))).onConflictDoNothing();
  }
  // Move all PAP records to main user
  await db.execute(sql`UPDATE pap_records SET user_id = ${mainUserId} WHERE user_id = ${orphan.id}`);
  // The spendable balance is canonical; totalPap is only a mirrored legacy field.
  if (orphan.redeemablePap > 0 || orphan.lockedPap > 0) {
    await db.update(usersTable)
      .set({
        ...incrementPapBalance(orphan.redeemablePap),
        lockedPap: sql`locked_pap + ${orphan.lockedPap}`,
      })
      .where(eq(usersTable.id, mainUserId));
  }
  // Keep immutable PAP Market history while moving live ownership to the main account.
  await db.update(papMarketOrdersTable).set({ ownerId: mainUserId }).where(eq(papMarketOrdersTable.ownerId, orphan.id));
  await db.update(papMarketTransactionsTable).set({ buyerId: mainUserId }).where(eq(papMarketTransactionsTable.buyerId, orphan.id));
  await db.update(papMarketTransactionsTable).set({ sellerId: mainUserId }).where(eq(papMarketTransactionsTable.sellerId, orphan.id));
  await db.update(papMarketTransactionsTable).set({ reviewedBy: mainUserId }).where(eq(papMarketTransactionsTable.reviewedBy, orphan.id));
  await db.update(papLedgerTable).set({ userId: mainUserId }).where(eq(papLedgerTable.userId, orphan.id));
  await db.update(papLedgerTable).set({ adminId: mainUserId }).where(eq(papLedgerTable.adminId, orphan.id));
  await db.update(papMarketAdminLogsTable).set({ adminId: mainUserId }).where(eq(papMarketAdminLogsTable.adminId, orphan.id));
  // Reassign all of orphan's character records to main user (all as alts)
  await db.update(charactersTable).set({
    userId: mainUserId,
    isMain: false,
    deletedAt: null,
    retainedUntil: null,
  }).where(and(eq(charactersTable.userId, orphan.id), isNull(charactersTable.deletedAt)));
  // Delete orphan user row
  await db.delete(usersTable).where(eq(usersTable.id, orphan.id));
  log.info({ orphanId: orphan.id, mainUserId, orphanPap: orphan.redeemablePap }, "Orphan user merged into main account");
}

async function findActiveCharacterByEveId(characterId: number) {
  const [character] = await db
    .select()
    .from(charactersTable)
    .where(and(eq(charactersTable.eveCharacterId, characterId), isNull(charactersTable.deletedAt)))
    .limit(1);

  return character ?? null;
}

async function findRetainedDeletedCharacterByEveId(characterId: number) {
  const [character] = await db
    .select()
    .from(charactersTable)
    .where(and(
      eq(charactersTable.eveCharacterId, characterId),
      isNotNull(charactersTable.deletedAt),
      gt(charactersTable.retainedUntil, new Date()),
    ))
    .orderBy(desc(charactersTable.deletedAt))
    .limit(1);

  return character ?? null;
}

async function restoreDeletedCharacter(
  character: typeof charactersTable.$inferSelect,
  userId: number,
  isMain: boolean,
  characterName: string,
  corporationId: number | null,
  corporationName: string | null,
  tokens?: { accessToken: string; refreshToken: string; tokenExpiry: Date },
) {
  const [restored] = await db
    .update(charactersTable)
    .set({
      userId,
      eveCharacterName: characterName,
      corporationId,
      corporationName,
      ...(tokens
        ? {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            tokenExpiry: tokens.tokenExpiry,
          }
        : {}),
      isMain,
      deletedAt: null,
      retainedUntil: null,
    })
    .where(eq(charactersTable.id, character.id))
    .returning();

  return restored;
}

async function accountNeedsMainCharacter(userId: number, user?: typeof usersTable.$inferSelect | null): Promise<boolean> {
  if (!user) {
    [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  }

  if (!user?.eveCharacterId) return true;

  const [activeMain] = await db
    .select({ id: charactersTable.id })
    .from(charactersTable)
    .where(and(
      eq(charactersTable.userId, userId),
      eq(charactersTable.isMain, true),
      isNull(charactersTable.deletedAt),
    ))
    .limit(1);

  return !activeMain;
}

async function setCharacterAsAccountMain(
  userId: number,
  character: Pick<typeof charactersTable.$inferSelect, "id" | "eveCharacterId" | "eveCharacterName" | "corporationId" | "corporationName">,
  tokens: {
    accessToken: string;
    refreshToken: string;
    tokenExpiry: Date;
    corporationJoinedAt: Date | null;
  },
): Promise<void> {
  await db.update(charactersTable).set({ isMain: false }).where(and(
    eq(charactersTable.userId, userId),
    isNull(charactersTable.deletedAt),
  ));
  await db.update(charactersTable).set({
    userId,
    isMain: true,
    deletedAt: null,
    retainedUntil: null,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiry: tokens.tokenExpiry,
  }).where(eq(charactersTable.id, character.id));
  await db.update(usersTable).set({
    eveCharacterId: character.eveCharacterId,
    eveCharacterName: character.eveCharacterName,
    corporationId: character.corporationId,
    corporationName: character.corporationName,
    corporationJoinedAt: tokens.corporationJoinedAt,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenExpiry: tokens.tokenExpiry,
  }).where(eq(usersTable.id, userId));
}

async function establishTenantSession(
  req: Request,
  user: typeof usersTable.$inferSelect,
  corporationId: number,
  corporationName: string,
  eveCharacterId: number,
): Promise<void> {
  await ensureCorporation(corporationId, corporationName);
  await ensureCorporationMembership(
    user.id,
    corporationId,
    user.role as "member" | "fc" | "admin" | "controller",
  );
  req.session.corporationId = corporationId;
  req.session.eveCharacterId = eveCharacterId;
}

function getCallbackUrl(req: Request): string {
  // Use the forwarded host so the callback URL always matches the domain
  // the user is actually visiting (dev preview or published app).
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim()
    ?? req.get("host")
    ?? "localhost";
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim()
    ?? req.protocol
    ?? "https";
  return `${proto}://${host}/api/auth/eve/callback`;
}

function getFrontendRedirectUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;

  // Railway serves the frontend and API from the same origin. Relative
  // redirects keep working when the public domain changes or a custom domain
  // is introduced, even if an old FRONTEND_URL is still configured.
  if (process.env.NODE_ENV === "production") return normalizedPath;

  const frontendUrl = process.env.FRONTEND_URL?.trim();
  if (!frontendUrl) return normalizedPath;

  return new URL(normalizedPath, `${frontendUrl.replace(/\/+$/, "")}/`).toString();
}

function redirectToFrontend(res: Response, path: string): void {
  res.redirect(getFrontendRedirectUrl(path));
}

function validOauthState(expected: string | undefined, received: unknown): received is string {
  if (!expected || typeof received !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return expectedBuffer.length === receivedBuffer.length && timingSafeEqual(expectedBuffer, receivedBuffer);
}

function authCallbackErrorDetails(error: unknown) {
  const outer = error && typeof error === "object"
    ? error as { name?: unknown; cause?: unknown }
    : null;
  const cause = outer?.cause && typeof outer.cause === "object"
    ? outer.cause as { code?: unknown; constraint?: unknown }
    : null;

  return {
    errorType: typeof outer?.name === "string" ? outer.name : typeof error,
    errorCode: typeof cause?.code === "string" ? cause.code : undefined,
    constraint: typeof cause?.constraint === "string" ? cause.constraint : undefined,
  };
}

// GET /api/auth/eve/login - redirect to EVE SSO
router.get("/auth/eve/login", (req: Request, res: Response): void => {
  const callbackUrl = getCallbackUrl(req);
  const state = generateOauthState();
  req.session.eveOauthState = state;
  req.session.eveOauthFlow = "login";
  req.session.linkingUserId = undefined;
  req.session.economyLinkCorporationId = undefined;
  req.session.rosterLinkCorporationId = undefined;
  req.session.structuresLinkCorporationId = undefined;
  req.session.save((error) => {
    if (error) {
      res.status(500).json({ error: "Unable to start EVE SSO" });
      return;
    }
    req.log.info({ callbackUrl }, "Redirecting to EVE SSO");
    res.redirect(getAuthorizationUrl(callbackUrl, state));
  });
});

// GET /api/auth/eve/link-alt - start alt character linking (must be logged in)
router.get("/auth/eve/link-alt", requireAuth, (req: Request, res: Response): void => {
  req.session.linkingUserId = req.session.userId;
  req.session.economyLinkCorporationId = undefined;
  req.session.rosterLinkCorporationId = undefined;
  req.session.structuresLinkCorporationId = undefined;
  const state = generateOauthState();
  req.session.eveOauthState = state;
  req.session.eveOauthFlow = "link_alt";
  req.session.save((err) => {
    if (err) {
      req.log.error({ err }, "Session save error for link-alt");
      redirectToFrontend(res, "/characters?error=session");
      return;
    }
    const callbackUrl = getCallbackUrl(req);
    req.log.info({ callbackUrl, userId: req.session.linkingUserId }, "Starting alt character link via EVE SSO");
    const url = getLinkAltAuthorizationUrl(callbackUrl, state);
    res.redirect(url);
  });
});

// GET /api/auth/eve/callback - EVE SSO callback
router.get("/auth/eve/callback", async (req: Request, res: Response): Promise<void> => {
  const { code, state } = req.query;
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Missing authorization code" });
    return;
  }
  if (!validOauthState(req.session.eveOauthState, state) || !req.session.eveOauthFlow) {
    res.status(400).json({ error: "Invalid or expired EVE SSO state" });
    return;
  }
  const oauthFlow = req.session.eveOauthFlow;
  if (
    (oauthFlow === "economy" && !req.session.economyLinkCorporationId)
    || (oauthFlow === "roster" && !req.session.rosterLinkCorporationId)
    || (oauthFlow === "structures" && !req.session.structuresLinkCorporationId)
    || (oauthFlow === "link_alt" && !req.session.linkingUserId)
  ) {
    res.status(400).json({ error: "Invalid EVE SSO flow" });
    return;
  }
  req.session.eveOauthState = undefined;
  req.session.eveOauthFlow = undefined;
  try {
    await new Promise<void>((resolve, reject) => req.session.save((error) => error ? reject(error) : resolve()));
  } catch {
    res.status(500).json({ error: "Unable to validate EVE SSO session" });
    return;
  }

  const callbackUrl = getCallbackUrl(req);

  try {
    const { accessToken, refreshToken, expiresIn } = await exchangeCode(code, callbackUrl);
    const { characterId, characterName, corporationId } = await getCharacterInfo(accessToken);

    let corporationName = "";
    if (corporationId) {
      corporationName = await getCorporationName(corporationId);
    }

    const tokenExpiry = new Date(Date.now() + expiresIn * 1000);
    const corporationJoinedAt = corporationId
      ? await getCorporationJoinDate(characterId, corporationId)
      : null;
    const mainCharacterTokens = { accessToken, refreshToken, tokenExpiry, corporationJoinedAt };

    if (oauthFlow === "structures" && req.session.structuresLinkCorporationId) {
      const targetCorporationId = req.session.structuresLinkCorporationId;
      req.session.structuresLinkCorporationId = undefined;
      const tenant = await getTenantContext(req);
      if (
        !tenant
        || tenant.corporation.id !== targetCorporationId
        || corporationId !== targetCorporationId
        || !hasRole(tenant.membership.role, "admin")
      ) {
        redirectToFrontend(res, "/structures?error=structures_forbidden");
        return;
      }
      await db
        .insert(corporationStructureConnectionsTable)
        .values({
          corporationId: targetCorporationId,
          characterId,
          connectedBy: tenant.user.id,
          accessToken,
          refreshToken,
          tokenExpiry,
          status: "connected",
          lastError: null,
        })
        .onConflictDoUpdate({
          target: corporationStructureConnectionsTable.corporationId,
          set: {
            characterId,
            connectedBy: tenant.user.id,
            accessToken,
            refreshToken,
            tokenExpiry,
            status: "connected",
            lastError: null,
            updatedAt: new Date(),
          },
        });
      req.session.save(() => {});
      redirectToFrontend(res, "/structures?authorization=connected");
      return;
    }

    if (oauthFlow === "roster" && req.session.rosterLinkCorporationId) {
      const targetCorporationId = req.session.rosterLinkCorporationId;
      req.session.rosterLinkCorporationId = undefined;
      const tenant = await getTenantContext(req);
      if (
        !tenant
        || tenant.corporation.id !== targetCorporationId
        || corporationId !== targetCorporationId
        || (!tenant.permissions.includes("activity.manage")
          && !hasRole(tenant.membership.role, "admin"))
      ) {
        redirectToFrontend(res, "/admin/activity?error=roster_forbidden");
        return;
      }
      await db
        .insert(corporationRosterConnectionsTable)
        .values({
          corporationId: targetCorporationId,
          characterId,
          connectedBy: tenant.user.id,
          accessToken,
          refreshToken,
          tokenExpiry,
          status: "connected",
          lastError: null,
        })
        .onConflictDoUpdate({
          target: corporationRosterConnectionsTable.corporationId,
          set: {
            characterId,
            connectedBy: tenant.user.id,
            accessToken,
            refreshToken,
            tokenExpiry,
            status: "connected",
            lastError: null,
            updatedAt: new Date(),
          },
        });
      req.session.save(() => {});
      redirectToFrontend(res, "/admin/activity?roster=connected");
      return;
    }

    if (oauthFlow === "economy" && req.session.economyLinkCorporationId) {
      const targetCorporationId = req.session.economyLinkCorporationId;
      req.session.economyLinkCorporationId = undefined;
      const tenant = await getTenantContext(req);
      if (
        !tenant
        || tenant.corporation.id !== targetCorporationId
        || corporationId !== targetCorporationId
        || !tenant.permissions.includes("economy.manage")
      ) {
        redirectToFrontend(res, "/economy?error=wallet_forbidden");
        return;
      }
      await db
        .insert(corporationWalletConnectionsTable)
        .values({
          corporationId: targetCorporationId,
          characterId,
          connectedBy: tenant.user.id,
          accessToken,
          refreshToken,
          tokenExpiry,
          status: "connected",
          lastError: null,
        })
        .onConflictDoUpdate({
          target: corporationWalletConnectionsTable.corporationId,
          set: {
            characterId,
            connectedBy: tenant.user.id,
            accessToken,
            refreshToken,
            tokenExpiry,
            status: "connected",
            lastError: null,
            updatedAt: new Date(),
          },
        });
      req.session.save(() => {});
      redirectToFrontend(res, "/economy?wallet=connected");
      return;
    }

    // Alt character linking flow
    if (oauthFlow === "link_alt" && req.session.linkingUserId) {
      const mainUserId = req.session.linkingUserId;
      req.session.linkingUserId = undefined;
      const [mainUser] = await db.select().from(usersTable).where(eq(usersTable.id, mainUserId));
      if (corporationId) {
        await ensureCorporation(corporationId, corporationName);
        await ensureCorporationMembership(mainUserId, corporationId, "member");
      }
      const shouldBecomeMain = await accountNeedsMainCharacter(mainUserId, mainUser ?? null);

      // Check if this character is already actively linked.
      const existingChar = await findActiveCharacterByEveId(characterId);

      if (existingChar) {
        if (existingChar.userId === mainUserId) {
          // Already linked to this account — overwrite name/corp in case it changed
          const [updatedChar] = await db.update(charactersTable).set({
            eveCharacterName: characterName,
            corporationId,
            corporationName,
            accessToken,
            refreshToken,
            tokenExpiry,
          }).where(eq(charactersTable.id, existingChar.id)).returning();
          if (shouldBecomeMain && updatedChar) {
            await setCharacterAsAccountMain(mainUserId, updatedChar, mainCharacterTokens);
          }
          req.log.info({ charId: characterId, mainUserId }, "Re-linked character updated");
          req.session.save(() => {});
          redirectToFrontend(res, "/characters?linked=true");
          return;
        }
        if (!existingChar.userId) {
          const [reclaimedChar] = await db.update(charactersTable).set({
            userId: mainUserId,
            eveCharacterName: characterName,
            corporationId,
            corporationName,
            isMain: shouldBecomeMain,
            accessToken,
            refreshToken,
            tokenExpiry,
          }).where(eq(charactersTable.id, existingChar.id)).returning();
          if (shouldBecomeMain && reclaimedChar) {
            await setCharacterAsAccountMain(mainUserId, reclaimedChar, mainCharacterTokens);
          }
          req.log.info({ charId: characterId, mainUserId }, "Reclaimed unowned active character on alt link");
          req.session.save(() => {});
          redirectToFrontend(res, "/characters?linked=true");
          return;
        }
        // Belongs to a different user — check if it is an orphan (auto-registered, no access token)
        const [charOwner] = await db.select().from(usersTable).where(eq(usersTable.id, existingChar.userId));
        if (charOwner?.accessToken) {
          // Another real authenticated user owns this character — cannot steal it
          req.session.save(() => {});
          redirectToFrontend(res, "/characters?error=already_linked");
          return;
        }
        // Orphan account: merge its PAP into the main account then delete it
        await mergeOrphanUser(charOwner ?? null, mainUserId, req.log);
        if (shouldBecomeMain) {
          const [mergedChar] = await db
            .select()
            .from(charactersTable)
            .where(and(
              eq(charactersTable.id, existingChar.id),
              eq(charactersTable.userId, mainUserId),
              isNull(charactersTable.deletedAt),
            ));
          if (mergedChar) {
            await setCharacterAsAccountMain(mainUserId, mergedChar, mainCharacterTokens);
          }
        }
        req.log.info({ orphanId: existingChar.userId, mainUserId, charId: characterId }, "Merged orphan (from chars table) into main account on alt link");
        req.session.save(() => {});
        redirectToFrontend(res, "/characters?linked=true");
        return;
      }

      const deletedChar = await findRetainedDeletedCharacterByEveId(characterId);
      if (deletedChar) {
        const restoredChar = await restoreDeletedCharacter(
          deletedChar,
          mainUserId,
          shouldBecomeMain,
          characterName,
          corporationId,
          corporationName,
          { accessToken, refreshToken, tokenExpiry },
        );
        if (shouldBecomeMain) {
          await setCharacterAsAccountMain(mainUserId, restoredChar, mainCharacterTokens);
        }
        req.log.info({ charId: characterId, mainUserId, previousCharId: deletedChar.id }, "Restored deleted character on alt link");
        req.session.save(() => {});
        redirectToFrontend(res, "/characters?linked=true");
        return;
      }

      // No characters record — also check if there is an orphan user in usersTable
      // (auto-registered by fleet scan before a characters record was written)
      const [orphanByMain] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.eveCharacterId, characterId));

      if (orphanByMain && orphanByMain.id !== mainUserId) {
        if (orphanByMain.accessToken) {
          req.session.save(() => {});
          redirectToFrontend(res, "/characters?error=already_linked");
          return;
        }
        // Orphan in usersTable — create the characters record first, then merge
        await db.insert(charactersTable).values({
          userId: orphanByMain.id,
          eveCharacterId: characterId,
          eveCharacterName: characterName,
          corporationId,
          corporationName,
          isMain: true,
          accessToken,
          refreshToken,
          tokenExpiry,
        });
        await mergeOrphanUser(orphanByMain, mainUserId, req.log);
        if (shouldBecomeMain) {
          const [mergedChar] = await db
            .select()
            .from(charactersTable)
            .where(and(
              eq(charactersTable.eveCharacterId, characterId),
              eq(charactersTable.userId, mainUserId),
              isNull(charactersTable.deletedAt),
            ))
            .limit(1);
          if (mergedChar) {
            await setCharacterAsAccountMain(mainUserId, mergedChar, mainCharacterTokens);
          }
        }
        req.log.info({ orphanId: orphanByMain.id, mainUserId, charId: characterId }, "Merged orphan (from users table) into main account on alt link");
        req.session.save(() => {});
        redirectToFrontend(res, "/characters?linked=true");
        return;
      }

      // Clean case: no orphan, just insert the characters record
      const [newChar] = await db.insert(charactersTable).values({
        userId: mainUserId,
        eveCharacterId: characterId,
        eveCharacterName: characterName,
        corporationId,
        corporationName,
        isMain: shouldBecomeMain,
        accessToken,
        refreshToken,
        tokenExpiry,
      }).returning();
      if (shouldBecomeMain && newChar) {
        await setCharacterAsAccountMain(mainUserId, newChar, mainCharacterTokens);
      }

      req.session.save((saveErr) => {
        if (saveErr) req.log.error({ err: saveErr }, "Session save error after alt link");
        redirectToFrontend(res, "/characters?linked=true");
      });
      return;
    }

    // Character rows are scoped to a corporation and protected by a foreign
    // key. Ensure a newly encountered EVE corporation exists before creating
    // or restoring the login character; establishTenantSession used to do
    // this only after the character write, which made first-time logins fail.
    await ensureCorporation(corporationId, corporationName);

    // Find or create user by EVE character ID.
    // First check usersTable (main character), then charactersTable (linked alt)
    // to prevent alts from creating a separate account on direct login.
    let [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.eveCharacterId, characterId));

    if (!user) {
      // Character may be a linked alt — look it up in the characters table
      const linkedChar = await findActiveCharacterByEveId(characterId);

      if (linkedChar?.userId) {
        // Log in as the owning main account instead of creating a new user
        const [mainUser] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, linkedChar.userId));
        if (mainUser) {
          if (linkedChar.isMain || !mainUser.eveCharacterId) {
            await setCharacterAsAccountMain(mainUser.id, linkedChar, mainCharacterTokens);
          }
          req.session.userId = mainUser.id;
          await establishTenantSession(req, mainUser, corporationId, corporationName, characterId);
          req.session.save((err) => {
            if (err) {
              req.log.error({ err }, "Session save error (alt-as-main login)");
              redirectToFrontend(res, "/?error=session");
              return;
            }
            req.log.info({ altCharId: characterId, mainUserId: mainUser.id }, "Alt character login resolved to main account");
            redirectToFrontend(res, "/");
          });
          return;
        }
      }
    }

    if (!user) {
      // Check if there are any users (first user becomes admin)
      const allUsers = await db.select().from(usersTable);
      const isFirstUser = allUsers.length === 0;

      [user] = await db
        .insert(usersTable)
        .values({
          eveCharacterId: characterId,
          eveCharacterName: characterName,
          corporationId,
          corporationName,
          corporationJoinedAt,
          accessToken,
          refreshToken,
          tokenExpiry,
          role: isFirstUser ? "admin" : "member",
          totalPap: 0,
          redeemablePap: 0,
        })
        .returning();

      const deletedChar = await findRetainedDeletedCharacterByEveId(characterId);
      if (deletedChar) {
        await restoreDeletedCharacter(
          deletedChar,
          user.id,
          true,
          characterName,
          corporationId,
          corporationName,
          { accessToken, refreshToken, tokenExpiry },
        );
        req.log.info({ charId: characterId, userId: user.id, previousCharId: deletedChar.id }, "Restored deleted character on main login");
      } else {
        // Create the character record
        await db.insert(charactersTable).values({
          userId: user.id,
          eveCharacterId: characterId,
          eveCharacterName: characterName,
          corporationId,
          corporationName,
          isMain: true,
          accessToken,
          refreshToken,
          tokenExpiry,
        });
      }
    } else {
      // Update tokens and character info
      [user] = await db
        .update(usersTable)
        .set({
          eveCharacterName: characterName,
          corporationId,
          corporationName,
          corporationJoinedAt: corporationJoinedAt
            ?? (user.corporationId === corporationId ? user.corporationJoinedAt : null),
          accessToken,
          refreshToken,
          tokenExpiry,
        })
        .where(eq(usersTable.id, user.id))
        .returning();

      // Upsert character
      const existingChar = await findActiveCharacterByEveId(characterId);

      if (!existingChar) {
        const deletedChar = await findRetainedDeletedCharacterByEveId(characterId);
        if (deletedChar) {
          await restoreDeletedCharacter(
            deletedChar,
            user.id,
            true,
            characterName,
            corporationId,
            corporationName,
            { accessToken, refreshToken, tokenExpiry },
          );
          req.log.info({ charId: characterId, userId: user.id, previousCharId: deletedChar.id }, "Restored deleted character for existing main login");
        } else {
          await db.insert(charactersTable).values({
            userId: user.id,
            eveCharacterId: characterId,
            eveCharacterName: characterName,
            corporationId,
            corporationName,
            isMain: true,
            accessToken,
            refreshToken,
            tokenExpiry,
          });
        }
      } else {
        await db
          .update(charactersTable)
          .set({
            eveCharacterName: characterName,
            corporationId,
            corporationName,
            accessToken,
            refreshToken,
            tokenExpiry,
          })
          .where(eq(charactersTable.id, existingChar.id));
      }
    }

    await establishTenantSession(req, user, corporationId, corporationName, characterId);
    req.session.userId = user.id;
    req.session.save((err) => {
      if (err) {
        req.log.error({ err }, "Session save error");
        redirectToFrontend(res, "/?error=session");
        return;
      }
      redirectToFrontend(res, "/");
    });
  } catch (err) {
    req.log.error(authCallbackErrorDetails(err), "EVE SSO callback error");
    redirectToFrontend(res, "/?error=auth");
  }
});

// GET /api/auth/me - get current user
router.get("/auth/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const tenant = await getTenantContext(req);
  if (!tenant) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "User not found" });
    return;
  }
  const tacticalGroups = tenant.corporation.identityEnabled
    ? await db
      .select({
        id: identityGroupsTable.id,
        name: identityGroupsTable.name,
        description: identityGroupsTable.description,
        joinedAt: identityGroupMembershipsTable.createdAt,
      })
      .from(identityGroupMembershipsTable)
      .innerJoin(identityGroupsTable, and(
        eq(identityGroupsTable.id, identityGroupMembershipsTable.groupId),
        eq(identityGroupsTable.corporationId, tenant.corporation.id),
        eq(identityGroupsTable.category, "combat"),
        eq(identityGroupsTable.isActive, true),
      ))
      .where(and(
        eq(identityGroupMembershipsTable.corporationId, tenant.corporation.id),
        eq(identityGroupMembershipsTable.userId, tenant.user.id),
      ))
      .orderBy(identityGroupsTable.name)
    : [];

  res.json({
    id: tenant.user.id,
    eveCharacterId: tenant.actorCharacter?.eveCharacterId ?? null,
    eveCharacterName: tenant.actorCharacter?.eveCharacterName ?? null,
    corporationId: tenant.corporation.id,
    corporationName: tenant.corporation.name,
    isPrimaryCorporation: tenant.corporation.isPrimary,
    role: tenant.membership.role,
    permissions: tenant.permissions,
    reimbursementOpen: tenant.corporation.reimbursementOpen,
    tacticalGroups,
    modules: {
      pap: tenant.corporation.papEnabled,
      identity: tenant.corporation.identityEnabled,
      economy: tenant.corporation.economyEnabled,
      fleet: tenant.corporation.fleetEnabled,
      reimbursement: tenant.corporation.reimbursementEnabled,
      diplomacy: tenant.corporation.diplomacyEnabled,
      courier: tenant.corporation.courierEnabled,
      structures: tenant.corporation.structuresEnabled,
    },
    pap: tenant.corporation.papEnabled ? availablePap(tenant.user.redeemablePap, tenant.user.lockedPap) : 0,
    totalPap: tenant.corporation.papEnabled ? tenant.user.redeemablePap : 0,
    redeemablePap: tenant.corporation.papEnabled ? tenant.user.redeemablePap : 0,
    availablePap: tenant.corporation.papEnabled ? availablePap(tenant.user.redeemablePap, tenant.user.lockedPap) : 0,
    lockedPap: tenant.corporation.papEnabled ? tenant.user.lockedPap : 0,
    createdAt: tenant.user.createdAt,
  });
});

// POST /api/auth/logout
router.post("/auth/logout", (req: Request, res: Response): void => {
  req.session.destroy((err) => {
    if (err) {
      logger.error({ err }, "Session destroy error");
    }
    res.json({ success: true, message: "Logged out" });
  });
});

export default router;
