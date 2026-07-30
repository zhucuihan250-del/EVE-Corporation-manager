import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, charactersTable, papRecordsTable } from "@workspace/db";
import { and, desc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { getAuthorizationUrl, getLinkAltAuthorizationUrl, exchangeCode, getCharacterInfo, getCorporationName } from "../lib/eve-sso";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";
import { getCorporationJoinDate } from "../lib/corporation-membership";

const router: IRouter = Router();

/** Transfer all PAP + character records from an orphan user into a main account, then delete the orphan. */
async function mergeOrphanUser(
  orphan: typeof usersTable.$inferSelect | null,
  mainUserId: number,
  log: { info: (obj: object, msg: string) => void },
): Promise<void> {
  if (!orphan) return;
  // Move all PAP records to main user
  await db.execute(sql`UPDATE pap_records SET user_id = ${mainUserId} WHERE user_id = ${orphan.id}`);
  // Add orphan's accumulated PAP totals to main user
  if (orphan.totalPap > 0 || orphan.redeemablePap > 0) {
    await db.update(usersTable).set({
      totalPap: sql`total_pap + ${orphan.totalPap}`,
      redeemablePap: sql`redeemable_pap + ${orphan.redeemablePap}`,
    }).where(eq(usersTable.id, mainUserId));
  }
  // Reassign all of orphan's character records to main user (all as alts)
  await db.update(charactersTable).set({
    userId: mainUserId,
    isMain: false,
    deletedAt: null,
    retainedUntil: null,
  }).where(and(eq(charactersTable.userId, orphan.id), isNull(charactersTable.deletedAt)));
  // Delete orphan user row
  await db.delete(usersTable).where(eq(usersTable.id, orphan.id));
  log.info({ orphanId: orphan.id, mainUserId, orphanPap: orphan.totalPap }, "Orphan user merged into main account");
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
) {
  const [restored] = await db
    .update(charactersTable)
    .set({
      userId,
      eveCharacterName: characterName,
      corporationId,
      corporationName,
      isMain,
      deletedAt: null,
      retainedUntil: null,
    })
    .where(eq(charactersTable.id, character.id))
    .returning();

  return restored;
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

// GET /api/auth/eve/login - redirect to EVE SSO
router.get("/auth/eve/login", (req: Request, res: Response): void => {
  const callbackUrl = getCallbackUrl(req);
  req.log.info({ callbackUrl }, "Redirecting to EVE SSO");
  const url = getAuthorizationUrl(callbackUrl);
  res.redirect(url);
});

// GET /api/auth/eve/link-alt - start alt character linking (must be logged in)
router.get("/auth/eve/link-alt", requireAuth, (req: Request, res: Response): void => {
  req.session.linkingUserId = req.session.userId;
  req.session.save((err) => {
    if (err) {
      req.log.error({ err }, "Session save error for link-alt");
      redirectToFrontend(res, "/characters?error=session");
      return;
    }
    const callbackUrl = getCallbackUrl(req);
    req.log.info({ callbackUrl, userId: req.session.linkingUserId }, "Starting alt character link via EVE SSO");
    const url = getLinkAltAuthorizationUrl(callbackUrl);
    res.redirect(url);
  });
});

// GET /api/auth/eve/callback - EVE SSO callback
router.get("/auth/eve/callback", async (req: Request, res: Response): Promise<void> => {
  const { code } = req.query;
  if (!code || typeof code !== "string") {
    res.status(400).json({ error: "Missing authorization code" });
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

    // Alt character linking flow
    if (req.session.linkingUserId) {
      const mainUserId = req.session.linkingUserId;
      req.session.linkingUserId = undefined;

      // Check if this character is already actively linked.
      const existingChar = await findActiveCharacterByEveId(characterId);

      if (existingChar) {
        if (existingChar.userId === mainUserId) {
          // Already linked to this account — overwrite name/corp in case it changed
          await db.update(charactersTable).set({
            eveCharacterName: characterName,
            corporationId,
            corporationName,
          }).where(eq(charactersTable.id, existingChar.id));
          req.log.info({ charId: characterId, mainUserId }, "Re-linked character updated");
          req.session.save(() => {});
          redirectToFrontend(res, "/characters?linked=true");
          return;
        }
        if (!existingChar.userId) {
          await db.update(charactersTable).set({
            userId: mainUserId,
            eveCharacterName: characterName,
            corporationId,
            corporationName,
            isMain: false,
          }).where(eq(charactersTable.id, existingChar.id));
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
        req.log.info({ orphanId: existingChar.userId, mainUserId, charId: characterId }, "Merged orphan (from chars table) into main account on alt link");
        req.session.save(() => {});
        redirectToFrontend(res, "/characters?linked=true");
        return;
      }

      const deletedChar = await findRetainedDeletedCharacterByEveId(characterId);
      if (deletedChar) {
        await restoreDeletedCharacter(
          deletedChar,
          mainUserId,
          false,
          characterName,
          corporationId,
          corporationName,
        );
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
        });
        await mergeOrphanUser(orphanByMain, mainUserId, req.log);
        req.log.info({ orphanId: orphanByMain.id, mainUserId, charId: characterId }, "Merged orphan (from users table) into main account on alt link");
        req.session.save(() => {});
        redirectToFrontend(res, "/characters?linked=true");
        return;
      }

      // Clean case: no orphan, just insert the characters record
      await db.insert(charactersTable).values({
        userId: mainUserId,
        eveCharacterId: characterId,
        eveCharacterName: characterName,
        corporationId,
        corporationName,
        isMain: false,
      });

      req.session.save((saveErr) => {
        if (saveErr) req.log.error({ err: saveErr }, "Session save error after alt link");
        redirectToFrontend(res, "/characters?linked=true");
      });
      return;
    }

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
          req.session.userId = mainUser.id;
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

    const corporationJoinedAt = corporationId
      ? await getCorporationJoinDate(characterId, corporationId)
      : null;

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
          });
        }
      }
    }

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
    req.log.error({ err }, "EVE SSO callback error");
    redirectToFrontend(res, "/?error=auth");
  }
});

// GET /api/auth/me - get current user
router.get("/auth/me", requireAuth, async (req: Request, res: Response): Promise<void> => {
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, req.session.userId!));

  if (!user) {
    req.session.destroy(() => {});
    res.status(401).json({ error: "User not found" });
    return;
  }

  res.json({
    id: user.id,
    eveCharacterId: user.eveCharacterId,
    eveCharacterName: user.eveCharacterName,
    corporationId: user.corporationId,
    corporationName: user.corporationName,
    role: user.role,
    totalPap: user.totalPap,
    redeemablePap: user.redeemablePap,
    createdAt: user.createdAt,
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
