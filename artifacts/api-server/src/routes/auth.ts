import { Router, type IRouter, type Request, type Response } from "express";
import { db, usersTable, charactersTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuthorizationUrl, exchangeCode, getCharacterInfo, getCorporationName } from "../lib/eve-sso";
import { requireAuth } from "../middlewares/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

function getCallbackUrl(req: Request): string {
  // Use the forwarded host so the callback URL always matches the domain
  // the user is actually visiting (dev preview or published app).
  const host = req.get("x-forwarded-host") ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto") ?? req.protocol ?? "https";
  return `${proto}://${host}/api/auth/eve/callback`;
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
      res.redirect("/characters?error=session");
      return;
    }
    const callbackUrl = getCallbackUrl(req);
    req.log.info({ callbackUrl, userId: req.session.linkingUserId }, "Starting alt character link via EVE SSO");
    const url = getAuthorizationUrl(callbackUrl);
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

      const [existingChar] = await db
        .select()
        .from(charactersTable)
        .where(eq(charactersTable.eveCharacterId, characterId));

      if (existingChar) {
        req.session.save(() => {});
        res.redirect("/characters?error=already_linked");
        return;
      }

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
        res.redirect("/characters?linked=true");
      });
      return;
    }

    // Find or create user by EVE character ID
    let [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.eveCharacterId, characterId));

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
          accessToken,
          refreshToken,
          tokenExpiry,
          role: isFirstUser ? "admin" : "member",
          totalPap: 0,
          redeemablePap: 0,
        })
        .returning();

      // Create the character record
      await db.insert(charactersTable).values({
        userId: user.id,
        eveCharacterId: characterId,
        eveCharacterName: characterName,
        corporationId,
        corporationName,
        isMain: true,
      });
    } else {
      // Update tokens and character info
      [user] = await db
        .update(usersTable)
        .set({
          eveCharacterName: characterName,
          corporationId,
          corporationName,
          accessToken,
          refreshToken,
          tokenExpiry,
        })
        .where(eq(usersTable.id, user.id))
        .returning();

      // Upsert character
      const [existingChar] = await db
        .select()
        .from(charactersTable)
        .where(eq(charactersTable.eveCharacterId, characterId));

      if (!existingChar) {
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

    req.session.userId = user.id;
    req.session.save((err) => {
      if (err) {
        req.log.error({ err }, "Session save error");
        res.redirect("/?error=session");
        return;
      }
      res.redirect("/");
    });
  } catch (err) {
    req.log.error({ err }, "EVE SSO callback error");
    res.redirect("/?error=auth");
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
