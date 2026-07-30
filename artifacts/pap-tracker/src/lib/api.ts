import { setBaseUrl } from "@workspace/api-client-react";

function normalizeApiBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  return trimmed.replace(/\/+$/, "");
}

// Production is served by the API server from the same Railway origin. Keep
// deployed requests relative so a stale build-time domain cannot strand users
// after a public-domain migration. Development still supports a separate API.
export const API_BASE_URL = import.meta.env.DEV
  ? normalizeApiBaseUrl(
    import.meta.env.VITE_API_URL ?? import.meta.env.VITE_API_BASE_URL,
  )
  : null;

setBaseUrl(API_BASE_URL);

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return API_BASE_URL ? `${API_BASE_URL}${normalizedPath}` : normalizedPath;
}
