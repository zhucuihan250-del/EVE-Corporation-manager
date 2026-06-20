import { logger } from "./logger";

const EVE_SSO_BASE = "https://login.eveonline.com";
const ESI_BASE = "https://esi.evetech.net/latest";

export function getAuthorizationUrl(callbackUrl: string): string {
  const clientId = process.env.EVE_CLIENT_ID;
  if (!clientId) throw new Error("EVE_CLIENT_ID not set");

  const scopes = [
    "publicData",
    "esi-calendar.respond_calendar_events.v1",
    "esi-calendar.read_calendar_events.v1",
    "esi-location.read_location.v1",
    "esi-location.read_ship_type.v1",
    "esi-mail.organize_mail.v1",
    "esi-mail.read_mail.v1",
    "esi-mail.send_mail.v1",
    "esi-skills.read_skills.v1",
    "esi-skills.read_skillqueue.v1",
    "esi-wallet.read_character_wallet.v1",
    "esi-wallet.read_corporation_wallet.v1",
    "esi-search.search_structures.v1",
    "esi-clones.read_clones.v1",
    "esi-characters.read_contacts.v1",
    "esi-universe.read_structures.v1",
    "esi-killmails.read_killmails.v1",
    "esi-corporations.read_corporation_membership.v1",
    "esi-assets.read_assets.v1",
    "esi-planets.manage_planets.v1",
    "esi-fleets.read_fleet.v1",
    "esi-fleets.write_fleet.v1",
    "esi-ui.open_window.v1",
    "esi-ui.write_waypoint.v1",
    "esi-characters.write_contacts.v1",
    "esi-fittings.read_fittings.v1",
    "esi-fittings.write_fittings.v1",
    "esi-markets.structure_markets.v1",
    "esi-corporations.read_structures.v1",
    "esi-characters.read_loyalty.v1",
    "esi-characters.read_chat_channels.v1",
    "esi-characters.read_medals.v1",
    "esi-characters.read_standings.v1",
    "esi-characters.read_agents_research.v1",
    "esi-industry.read_character_jobs.v1",
    "esi-markets.read_character_orders.v1",
    "esi-characters.read_blueprints.v1",
    "esi-characters.read_corporation_roles.v1",
    "esi-location.read_online.v1",
    "esi-contracts.read_character_contracts.v1",
    "esi-clones.read_implants.v1",
    "esi-characters.read_fatigue.v1",
    "esi-killmails.read_corporation_killmails.v1",
    "esi-corporations.track_members.v1",
    "esi-wallet.read_corporation_wallets.v1",
    "esi-characters.read_notifications.v1",
    "esi-corporations.read_divisions.v1",
    "esi-corporations.read_contacts.v1",
    "esi-assets.read_corporation_assets.v1",
    "esi-corporations.read_titles.v1",
    "esi-corporations.read_blueprints.v1",
    "esi-contracts.read_corporation_contracts.v1",
    "esi-corporations.read_standings.v1",
    "esi-corporations.read_starbases.v1",
    "esi-industry.read_corporation_jobs.v1",
    "esi-markets.read_corporation_orders.v1",
    "esi-corporations.read_container_logs.v1",
    "esi-industry.read_character_mining.v1",
    "esi-industry.read_corporation_mining.v1",
    "esi-planets.read_customs_offices.v1",
    "esi-corporations.read_facilities.v1",
    "esi-corporations.read_medals.v1",
    "esi-characters.read_titles.v1",
    "esi-alliances.read_contacts.v1",
    "esi-characters.read_fw_stats.v1",
    "esi-corporations.read_fw_stats.v1",
    "esi-corporations.read_projects.v1",
    "esi-corporations.read_freelance_jobs.v1",
    "esi-characters.read_freelance_jobs.v1",
    "esi-structures.read_corporation.v1",
    "esi-structures.read_character.v1",
    "esi-activities.read_character.v1",
    "esi-access.read_lists.v1",
  ].join(" ");

  const params = new URLSearchParams({
    response_type: "code",
    redirect_uri: callbackUrl,
    client_id: clientId,
    scope: scopes,
    state: Math.random().toString(36).substring(2),
  });

  return `${EVE_SSO_BASE}/v2/oauth/authorize?${params.toString()}`;
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
