import type { Request, Response } from "express";
import type { db } from "@workspace/db";
import { charactersTable, dutyPapConnectionsTable } from "@workspace/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { generateOauthState } from "./eve-sso";
import { DUTY_PAP_SCOPES, DutyPapError, dutyPapId, type DutyPapActor } from "./duty-pap-rules";
import type { createDutyPapService } from "./duty-pap-service";

export type DutyPapOAuthTarget = { corporationId: number; userId: number; characterId: number; issuedAt: number; connectionVersion: number | null };
type Database = typeof db;
function callbackUrl(req: Request): string {
  const host = req.get("x-forwarded-host")?.split(",")[0]?.trim() ?? req.get("host") ?? "localhost";
  const proto = req.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? req.protocol ?? "https";
  return `${proto}://${host}/api/auth/eve/callback`;
}
function failure(): never { throw new DutyPapError(503, "DUTY_PAP_AUTH_UNAVAILABLE", "值守授权暂时不可用，请稍后重试。"); }
async function safeJson(response: globalThis.Response): Promise<unknown> {
  if (!response.ok || !response.body) failure();
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 65536) { await reader.cancel(); failure(); } chunks.push(value); }
    const joined = Buffer.concat(chunks); return JSON.parse(joined.toString("utf8"));
  } catch { failure(); } finally { reader.releaseLock(); }
}
/** A dedicated read-only consent flow. Never changes the site's login scopes,
 * the bound character's original tokens, or any character/account ownership. */
export function createDutyPapOAuthProvider(options: { request?: typeof fetch; getConfig?: () => { clientId?: string; clientSecret?: string }; now?: () => number } = {}) {
  const request: typeof fetch = (input, init) => (options.request ?? fetch)(input, init);
  const config = options.getConfig ?? (() => ({ clientId: process.env.EVE_CLIENT_ID, clientSecret: process.env.EVE_CLIENT_SECRET })), now = options.now ?? Date.now;
  function authorizationUrl(url: string, state: string): string {
    const { clientId } = config(); if (!clientId) failure();
    return "https://login.eveonline.com/v2/oauth/authorize?" + new URLSearchParams({ client_id: clientId!, redirect_uri: url, response_type: "code", scope: ["publicData", ...DUTY_PAP_SCOPES].join(" "), state }).toString();
  }
  async function exchangeAndVerify(code: string, url: string) {
    try {
      const { clientId, clientSecret } = config(); if (!clientId || !clientSecret) failure();
      const tokenBody = await safeJson(await request("https://login.eveonline.com/v2/oauth/token", { method: "POST", signal: AbortSignal.timeout(15000), headers: { Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"), "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: url }) })) as Record<string, unknown>;
      if (!tokenBody || typeof tokenBody !== "object" || typeof tokenBody.access_token !== "string" || !tokenBody.access_token || typeof tokenBody.refresh_token !== "string" || !tokenBody.refresh_token || !Number.isSafeInteger(tokenBody.expires_in) || Number(tokenBody.expires_in) < 1 || Number(tokenBody.expires_in) > 86400) failure();
      const accessToken = tokenBody.access_token as string, refreshToken = tokenBody.refresh_token as string;
      const verified = await safeJson(await request("https://login.eveonline.com/oauth/verify", { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15000) })) as Record<string, unknown>;
      if (!verified || !Number.isSafeInteger(verified.CharacterID) || Number(verified.CharacterID) <= 0) failure();
      // Decoding alone is NOT authentication. The official verify endpoint
      // above first authenticates this token and its CharacterID.
      const parts = accessToken.split("."); if (parts.length !== 3 || parts[1]!.length > 32768) failure();
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
      const scopes: unknown = claims.scp;
      if (!Array.isArray(scopes) || scopes.some(s => typeof s !== "string") || !DUTY_PAP_SCOPES.every(s => scopes.includes(s)) || claims.sub !== `CHARACTER:EVE:${verified.CharacterID}` || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now() || claims.azp !== clientId) {
        throw new DutyPapError(409, "DUTY_PAP_AUTH_SCOPE_REQUIRED", "请授权舰队、在线、位置和舰船四项只读权限。");
      }
      const affiliation = await safeJson(await request("https://esi.evetech.net/characters/affiliation", { method: "POST", headers: { "Content-Type": "application/json", "X-Compatibility-Date": "2026-07-20", "X-Tenant": "tranquility" }, body: JSON.stringify([verified.CharacterID]), signal: AbortSignal.timeout(15000) }));
      if (!Array.isArray(affiliation) || affiliation.length !== 1 || affiliation[0]?.character_id !== verified.CharacterID || !Number.isSafeInteger(affiliation[0]?.corporation_id)) failure();
      return { eveCharacterId: Number(verified.CharacterID), corporationId: Number(affiliation[0].corporation_id), scopes: scopes as string[], accessToken, refreshToken, tokenExpiry: new Date(now() + Number(tokenBody.expires_in) * 1000) };
    } catch (error) { if (error instanceof DutyPapError) throw error; failure(); }
  }
  return { authorizationUrl, exchangeAndVerify };
}

export function createDutyPapOAuthHandlers(dependencies: { database: Database; service: Pick<ReturnType<typeof createDutyPapService>, "authorizeConnection">; provider: ReturnType<typeof createDutyPapOAuthProvider>; getTenant: (req: Request) => Promise<NonNullable<Request["tenant"]> | null>; now?: () => number }) {
  const { database, service, provider } = dependencies, now = dependencies.now ?? Date.now;
  const ownCharacter = (actor: DutyPapActor, id: number) => database.select().from(charactersTable).where(and(eq(charactersTable.id, id), eq(charactersTable.userId, actor.userId), eq(charactersTable.corporationId, actor.corporationId), isNull(charactersTable.deletedAt))).limit(1);
  async function start(req: Request, res: Response) {
    const tenant = req.tenant; if (!tenant) { res.status(401).json({ error: "Unauthorized" }); return; }
    const actor: DutyPapActor = { corporationId: tenant.corporation.id, userId: tenant.user.id, userName: tenant.user.eveCharacterName ?? "成员", role: tenant.membership.role };
    try {
      if (typeof req.query.characterId !== "string" || !/^\d{1,10}$/.test(req.query.characterId)) throw new DutyPapError(400, "DUTY_PAP_INVALID_ID", "请选择本人已绑定的军团角色。");
      const id = dutyPapId(Number(req.query.characterId)); if (!(await ownCharacter(actor, id)).length) throw new DutyPapError(404, "DUTY_PAP_CHARACTER_NOT_FOUND", "找不到本人绑定的有效军团角色。");
      const [connection] = await database.select({ version: dutyPapConnectionsTable.version }).from(dutyPapConnectionsTable).where(and(eq(dutyPapConnectionsTable.corporationId, actor.corporationId), eq(dutyPapConnectionsTable.userId, actor.userId)));
      const state = generateOauthState(), redirect = provider.authorizationUrl(callbackUrl(req), state);
      req.session.eveOauthState = state; req.session.eveOauthFlow = "duty";
      req.session.dutyPapAuthorization = { corporationId: actor.corporationId, userId: actor.userId, characterId: id, issuedAt: now(), connectionVersion: connection?.version ?? null };
      req.session.linkingUserId = undefined; req.session.economyLinkCorporationId = undefined; req.session.rosterLinkCorporationId = undefined; req.session.structuresLinkCorporationId = undefined;
      await new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve())); res.redirect(redirect);
    } catch (error) { if (error instanceof DutyPapError) { res.status(error.status).json({ error: error.message, code: error.code }); return; } res.status(503).json({ error: "无法启动值守授权，请重试。", code: "DUTY_PAP_AUTH_UNAVAILABLE" }); }
  }
  async function complete(req: Request, target: DutyPapOAuthTarget | undefined, code: string, url: string) {
    if (!target || target.userId !== req.session.userId || !Number.isFinite(target.issuedAt) || now() - target.issuedAt < 0 || now() - target.issuedAt > 15 * 60000) throw new DutyPapError(403, "DUTY_PAP_AUTH_EXPIRED", "值守授权已过期，请重新开始。");
    const tenant = await dependencies.getTenant(req);
    if (!tenant || tenant.user.id !== target.userId || tenant.corporation.id !== target.corporationId || !tenant.corporation.papEnabled || !tenant.corporation.fleetEnabled) throw new DutyPapError(403, "DUTY_PAP_AUTH_FORBIDDEN", "当前账号无权完成该值守授权。");
    const actor: DutyPapActor = { corporationId: tenant.corporation.id, userId: tenant.user.id, userName: tenant.user.eveCharacterName ?? "成员", role: tenant.membership.role };
    const [character] = await ownCharacter(actor, target.characterId); if (!character) throw new DutyPapError(404, "DUTY_PAP_CHARACTER_NOT_FOUND", "角色已解绑或不属于当前军团。");
    const verified = await provider.exchangeAndVerify(code, url);
    if (verified.eveCharacterId !== character.eveCharacterId || verified.corporationId !== actor.corporationId) throw new DutyPapError(403, "DUTY_PAP_AUTH_CHARACTER_MISMATCH", "授权的角色与所选角色不一致，或已经离开军团。");
    return service.authorizeConnection(actor, { characterId: target.characterId, accessToken: verified.accessToken, refreshToken: verified.refreshToken, tokenExpiry: verified.tokenExpiry, scopes: verified.scopes, expectedVersion: target.connectionVersion });
  }
  return { start, complete };
}
