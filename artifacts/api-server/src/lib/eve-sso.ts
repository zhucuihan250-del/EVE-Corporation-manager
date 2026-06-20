import { logger } from "./logger";

const EVE_SSO_BASE = "https://login.eveonline.com";
const ESI_BASE = "https://esi.evetech.net/latest";

function buildAuthorizationUrl(callbackUrl: string, scopes: string[]): string {
  const clientId = process.env.EVE_CLIENT_ID;
  if (!clientId) throw new Error("EVE_CLIENT_ID not set");

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: callbackUrl,
    client_id: clientId,
    scope: scopes.join(" "),
    state: Math.random().toString(36).substring(2),
  });

  return `${EVE_SSO_BASE}/v2/oauth/authorize?${params.toString()}`;
}

export function getAuthorizationUrl(callbackUrl: string): string {
  return buildAuthorizationUrl(callbackUrl, [
    "publicData",
    "esi-fleets.read_fleet.v1",
    "esi-fleets.write_fleet.v1",
  ]);
}

export function getLinkAltAuthorizationUrl(callbackUrl: string): string {
  return buildAuthorizationUrl(callbackUrl, ["publicData"]);
}

export async function exchangeCode(code: string, callbackUrl: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const clientId = process.env.EVE_CLIENT_ID;
  const clientSecret = process.env.EVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("EVE SSO credentials not set");

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await fetch(`${EVE_SSO_BASE}/v2/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    logger.error({ status: resp.status, body: text }, "EVE SSO token exchange failed");
    throw new Error("EVE SSO token exchange failed");
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function getCharacterInfo(accessToken: string): Promise<{
  characterId: number;
  characterName: string;
  corporationId: number;
}> {
  // Verify the token and get character info from EVE SSO
  const resp = await fetch(`${EVE_SSO_BASE}/oauth/verify`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!resp.ok) {
    throw new Error("Failed to verify EVE SSO token");
  }

  const data = (await resp.json()) as {
    CharacterID: number;
    CharacterName: string;
  };

  // Get corporation from ESI
  let corporationId = 0;
  try {
    const charResp = await fetch(
      `${ESI_BASE}/characters/${data.CharacterID}/?datasource=tranquility`,
    );
    if (charResp.ok) {
      const charData = (await charResp.json()) as { corporation_id: number };
      corporationId = charData.corporation_id;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch corporation info");
  }

  return {
    characterId: data.CharacterID,
    characterName: data.CharacterName,
    corporationId,
  };
}

export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const clientId = process.env.EVE_CLIENT_ID;
  const clientSecret = process.env.EVE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("EVE SSO credentials not set");

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const resp = await fetch(`${EVE_SSO_BASE}/v2/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    logger.error({ status: resp.status, body: text }, "EVE SSO token refresh failed");
    throw new Error("EVE SSO token refresh failed");
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

export async function getCorporationName(corporationId: number): Promise<string> {
  try {
    const resp = await fetch(
      `${ESI_BASE}/corporations/${corporationId}/?datasource=tranquility`,
    );
    if (resp.ok) {
      const data = (await resp.json()) as { name: string };
      return data.name;
    }
  } catch (err) {
    logger.warn({ err }, "Failed to fetch corporation name");
  }
  return "";
}
