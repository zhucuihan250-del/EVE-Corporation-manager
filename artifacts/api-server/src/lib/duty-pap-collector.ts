import { EveTokenRefreshError, refreshAccessToken } from "./eve-sso";
import { DUTY_PAP_FRESH_MS, DUTY_PAP_SCOPES } from "./duty-pap-rules";

export type DutyPapCollectConnection = {
  corporationId: number; userId: number; characterId: number; eveCharacterId: number;
  accessToken: string; refreshToken: string; tokenExpiry: Date; scopes: string[];
};
export type DutyPapObservation = {
  observedAt: Date; evidenceAt: Date | null; valid: boolean; status: string;
  eveFleetId: string | null; corporationId: number | null; online: boolean | null;
  solarSystemId: number | null; shipTypeId: number | null; docked: boolean | null;
  tokenUpdate?: { accessToken: string; refreshToken: string; tokenExpiry: Date };
};
type TokenRefresh = (refreshToken: string) => Promise<{ accessToken: string; refreshToken: string; expiresIn: number }>;
class CollectError extends Error { constructor(readonly status: string) { super(status); } }
const ESI_ORIGIN = "https://esi.evetech.net";
const ENDPOINT_TIMEOUT_MS = 12_000;

/** This provider only reads the authorized character. It never fetches a boss's
 * fleet roster or performs an operation in the game. Bodies and tokens are not
 * included in errors or public status. The affiliation POST is a read query. */
export function createDutyPapCollector(options: { fetchImpl?: typeof fetch; now?: () => Date; refreshTokens?: TokenRefresh } = {}) {
  const request = options.fetchImpl ?? fetch, clock = options.now ?? (() => new Date()), refresh = options.refreshTokens ?? refreshAccessToken;
  let blockedUntil = 0;
  const affiliationCache = new Map<number, { body: Record<string, unknown>; evidenceAt: Date; expiresAt: number }>();
  async function collect(connection: DutyPapCollectConnection, options: { signal?: AbortSignal } = {}): Promise<DutyPapObservation> {
    let tokenUpdate: DutyPapObservation["tokenUpdate"];
    const empty = (status: string): DutyPapObservation => ({ observedAt: clock(), evidenceAt: null, valid: false, status, eveFleetId: null, corporationId: null, online: null, solarSystemId: null, shipTypeId: null, docked: null, ...(tokenUpdate ? { tokenUpdate } : {}) });
    if (blockedUntil > clock().getTime()) return empty("rate_limited");
    if (!DUTY_PAP_SCOPES.every(scope => connection.scopes.includes(scope))) return empty("authorization_required");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const timeout = setTimeout(abort, ENDPOINT_TIMEOUT_MS);
    try {
      let accessToken = connection.accessToken;
      if (connection.tokenExpiry.getTime() <= clock().getTime() + 60_000) {
        // A bounded race also handles an injected refresh implementation that
        // fails to observe AbortSignal. The official helper has its own limit.
        let rejectAbort: (() => void) | undefined;
        const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(new CollectError("unavailable")); controller.signal.addEventListener("abort", rejectAbort, { once: true }); });
        try {
          if (controller.signal.aborted) throw new CollectError("unavailable");
          const fresh = await Promise.race([refresh(connection.refreshToken), aborted]);
          if (!fresh.accessToken || !fresh.refreshToken || !Number.isFinite(fresh.expiresIn) || fresh.expiresIn <= 0) throw new CollectError("unavailable");
          accessToken = fresh.accessToken;
          tokenUpdate = { accessToken: fresh.accessToken, refreshToken: fresh.refreshToken, tokenExpiry: new Date(clock().getTime() + fresh.expiresIn * 1000) };
        } finally { if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort); }
      }
      const read = async (path: string, publicQuery = false): Promise<{ body: Record<string, unknown>; evidenceAt: Date }> => {
        if (publicQuery) {
          const cached = affiliationCache.get(connection.eveCharacterId);
          if (cached && cached.expiresAt > clock().getTime()) {
            affiliationCache.delete(connection.eveCharacterId); affiliationCache.set(connection.eveCharacterId, cached);
            return { body: cached.body, evidenceAt: cached.evidenceAt };
          }
          affiliationCache.delete(connection.eveCharacterId);
        }
        const response = await request(`${ESI_ORIGIN}${path.replace(/\/$/, "")}`, {
          method: publicQuery ? "POST" : "GET", signal: controller.signal,
          headers: { Accept: "application/json", "User-Agent": "EVE-Corporation-manager/1.0", "X-Compatibility-Date": "2026-07-20", "X-Tenant": "tranquility", ...(publicQuery ? { "Content-Type": "application/json" } : { Authorization: `Bearer ${accessToken}` }) },
          ...(publicQuery ? { body: JSON.stringify([connection.eveCharacterId]) } : {}),
        });
        const remainingHeader = response.headers.get("x-esi-error-limit-remain"), remaining = remainingHeader === null ? null : Number(remainingHeader);
        if (response.status === 420 || response.status === 429 || (remaining !== null && Number.isFinite(remaining) && remaining < 10)) {
          const rawRetry = response.headers.get("retry-after") ?? response.headers.get("x-esi-error-limit-reset") ?? "60";
          const numericRetry = /^\d+$/.test(rawRetry) ? Number(rawRetry) : (Date.parse(rawRetry) - clock().getTime()) / 1000;
          blockedUntil = clock().getTime() + Math.min(86_400, Math.max(60, Number.isFinite(numericRetry) ? numericRetry : 60)) * 1000;
          throw new CollectError("rate_limited");
        }
        if (response.status === 401 || response.status === 403) throw new CollectError("authorization_required");
        if (!response.ok) throw new CollectError(response.status === 404 && path.endsWith("/fleet/") ? "not_in_fleet" : "unavailable");
        const date = Date.parse(response.headers.get("date") ?? ""), ageText = response.headers.get("age") ?? "0";
        const age = /^\d+$/.test(ageText) ? Number(ageText) : NaN;
        const current = clock().getTime(), evidence = Math.min(date, current - age * 1000);
        // Last-Modified is not used: an unchanged online flag can legitimately
        // retain an old modification time. HTTP Date may already be the origin
        // generation time, so subtracting Age from Date would double-age it.
        // Affiliation has an official 3600-second cache TTL and is not evidence
        // of the current presence interval; local ownership is also rechecked.
        const maxAge = publicQuery ? 3_600_000 : DUTY_PAP_FRESH_MS;
        if (!Number.isFinite(evidence) || !Number.isFinite(age) || age < 0 || date > current + 5000 || current - evidence > maxAge) throw new CollectError("stale_data");
        const expires = response.headers.get("expires");
        if (expires && (!Number.isFinite(Date.parse(expires)) || Date.parse(expires) < current)) throw new CollectError("stale_data");
        const length = Number(response.headers.get("content-length") ?? "0");
        if (length > 65_536) throw new CollectError("unavailable");
        const reader = response.body?.getReader();
        if (!reader) throw new CollectError("unavailable");
        const chunks: Uint8Array[] = []; let bytes = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > 65_536) { await reader.cancel(); throw new CollectError("unavailable"); }
            chunks.push(part.value);
          }
        } finally { reader.releaseLock(); }
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload: unknown;
        try { payload = JSON.parse(raw); } catch { throw new CollectError("unavailable"); }
        const body = publicQuery && Array.isArray(payload) && payload.length === 1 ? payload[0] : payload;
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new CollectError("unavailable");
        if (publicQuery) {
          const record = body as Record<string, unknown>;
          // Cache only validated public affiliation. A stale response never gets
          // a new one-hour lifetime: the origin evidence age is deducted first.
          if (record.character_id !== connection.eveCharacterId || !Number.isSafeInteger(record.corporation_id) || Number(record.corporation_id) <= 0) throw new CollectError("unavailable");
          const control = response.headers.get("cache-control") ?? "", ttlText = control.match(/(?:^|,)\s*max-age=(\d+)/i)?.[1];
          const ttl = ttlText ? Math.min(3600, Number(ttlText)) : 3600;
          const expiresAt = Math.min(evidence + ttl * 1000, expires ? Date.parse(expires) : Number.POSITIVE_INFINITY);
          if (expiresAt > current && !/(?:^|,)\s*(?:no-store|no-cache)\b/i.test(control)) {
            affiliationCache.set(connection.eveCharacterId, { body: record, evidenceAt: new Date(evidence), expiresAt });
            while (affiliationCache.size > 5000) affiliationCache.delete(affiliationCache.keys().next().value!);
          }
        }
        return { body: body as Record<string, unknown>, evidenceAt: new Date(evidence) };
      };
      const [fleet, online, location, ship, affiliation] = await Promise.all([
        read(`/characters/${connection.eveCharacterId}/fleet/`), read(`/characters/${connection.eveCharacterId}/online/`),
        read(`/characters/${connection.eveCharacterId}/location/`), read(`/characters/${connection.eveCharacterId}/ship/`), read("/characters/affiliation/", true),
      ]);
      const id = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
      if (!id(fleet.body.fleet_id) || typeof online.body.online !== "boolean" || !id(location.body.solar_system_id) || !id(ship.body.ship_type_id)
        || !id(affiliation.body.corporation_id) || affiliation.body.character_id !== connection.eveCharacterId
        || (location.body.station_id !== undefined && !id(location.body.station_id)) || (location.body.structure_id !== undefined && !id(location.body.structure_id))) throw new CollectError("unavailable");
      const observedAt = clock(), evidenceAt = new Date(Math.min(...[fleet, online, location, ship].map(result => result.evidenceAt.getTime())));
      if (observedAt.getTime() - evidenceAt.getTime() > DUTY_PAP_FRESH_MS) throw new CollectError("stale_data");
      const currentCorporation = Number(affiliation.body.corporation_id), isOnline = online.body.online as boolean;
      return { observedAt, evidenceAt, valid: isOnline && currentCorporation === connection.corporationId,
        status: currentCorporation !== connection.corporationId ? "left_corporation" : !isOnline ? "offline" : "observed",
        corporationId: currentCorporation, online: isOnline, eveFleetId: String(fleet.body.fleet_id), solarSystemId: Number(location.body.solar_system_id), shipTypeId: Number(ship.body.ship_type_id), docked: location.body.station_id !== undefined || location.body.structure_id !== undefined,
        ...(tokenUpdate ? { tokenUpdate } : {}),
      };
    } catch (error) {
      controller.abort();
      return empty(error instanceof CollectError ? error.status : error instanceof EveTokenRefreshError && error.authorizationRequired ? "authorization_required" : "unavailable");
    } finally { clearTimeout(timeout); options.signal?.removeEventListener("abort", abort); }
  }
  return { collect };
}
export type DutyPapCollector = ReturnType<typeof createDutyPapCollector>;
