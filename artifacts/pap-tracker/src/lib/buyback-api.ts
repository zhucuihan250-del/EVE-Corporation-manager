import { apiUrl } from "@/lib/api";
export { formatBuybackIsk } from "./buyback-presentation";

export type BuybackPriceBasis = "buy" | "sell" | "mid" | "fixed";
export type BuybackSettings = {
  enabled: boolean;
  defaultEnabled: boolean;
  priceBasis: BuybackPriceBasis;
  ratePercent: number;
  fixedPrice: string | null;
  quoteValidityMinutes: number;
  version: number;
};
export type BuybackRuleInput = {
  scope: "category" | "type";
  targetId: number;
  enabled: boolean | null;
  priceBasis: BuybackPriceBasis | null;
  ratePercent: number | null;
  fixedPrice: string | null;
};
export type BuybackRule = BuybackRuleInput & {
  id: number;
  targetName?: string;
  targetNameEn?: string;
};
export type BuybackQuoteLine = {
  inputName: string;
  typeId: number | null;
  name: string;
  quantity: number | string;
  status: "accepted" | "excluded" | "unrecognized" | "unpriced" | "invalid";
  reason: string | null;
  priceBasis: BuybackPriceBasis | null;
  referencePrice: string | null;
  ratePercent: number | null;
  unitPrice: string | null;
  totalIsk: string | null;
  marketUpdatedAt?: string | null;
};
export type BuybackQuote = {
  id: number;
  createdAt: string;
  expiresAt: string;
  totalIsk: string;
  complete: boolean;
  settingsVersion: number;
  submitterName?: string;
  lines: BuybackQuoteLine[];
};
export type BuybackConfiguration = {
  settings: BuybackSettings;
  rules: BuybackRule[];
};
export type BuybackAdminData = BuybackConfiguration & {
  quotes: BuybackQuote[];
};
export type BuybackCatalogItem = {
  id: number;
  name: string;
  nameEn?: string;
  categoryId?: number;
  categoryName?: string;
};

export const buybackKeys = {
  all: ["buyback"] as const,
  settings: ["buyback", "settings"] as const,
  quotes: ["buyback", "quotes"] as const,
  admin: ["buyback", "admin"] as const,
  catalog: (kind: "category" | "type", query: string) =>
    ["buyback", "catalog", kind, query] as const,
};

async function request<T>(
  path: string,
  options?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: options?.method ?? "GET",
    credentials: "include",
    headers:
      options?.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body:
      options?.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options?.signal,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string"
        ? data.error
        : data &&
            typeof data === "object" &&
            "message" in data &&
            typeof data.message === "string"
          ? data.message
          : null;
    throw new Error(
      message && !/<\/?[a-z!][^>]*>/i.test(message)
        ? message
        : `请求失败（HTTP ${response.status}），请稍后重试。 / Request failed. Please try again.`,
    );
  }
  if (data === null)
    throw new Error(
      "服务器响应异常，请稍后重试。 / Unexpected server response.",
    );
  return data as T;
}

export const buybackApi = {
  settings: (signal?: AbortSignal) =>
    request<BuybackConfiguration>("/api/buyback/settings", { signal }),
  quotes: (signal?: AbortSignal) =>
    request<{ quotes: BuybackQuote[] }>("/api/buyback/quotes", { signal }),
  quote: (body: { text: string; requestId: string }) =>
    request<BuybackQuote>("/api/buyback/quotes", { method: "POST", body }),
  admin: (signal?: AbortSignal) =>
    request<BuybackAdminData>("/api/admin/buyback", { signal }),
  saveSettings: (body: BuybackSettings) =>
    request<BuybackConfiguration>("/api/admin/buyback/settings", {
      method: "PUT",
      body,
    }),
  saveRule: (id: number | null, body: BuybackRuleInput & { version: number }) =>
    request<BuybackConfiguration>(
      `/api/admin/buyback/rules${id === null ? "" : `/${id}`}`,
      { method: id === null ? "POST" : "PUT", body },
    ),
  deleteRule: (id: number, version: number) =>
    request<BuybackConfiguration>(`/api/admin/buyback/rules/${id}`, {
      method: "DELETE",
      body: { version },
    }),
  catalog: (kind: "category" | "type", query: string, signal?: AbortSignal) =>
    request<{ items: BuybackCatalogItem[] }>(
      `/api/buyback/catalog?${new URLSearchParams({ kind, query })}`,
      { signal },
    ),
};

export function buybackBasisLabel(
  basis: BuybackPriceBasis | null,
  zh: boolean,
): string {
  if (basis === null) return zh ? "继承上级" : "Inherit";
  const labels = {
    buy: ["吉他最高买价", "Jita highest buy"],
    sell: ["吉他最低卖价", "Jita lowest sell"],
    mid: ["吉他买卖中间价", "Jita midpoint"],
    fixed: ["固定单价", "Fixed unit price"],
  };
  return labels[basis]?.[zh ? 0 : 1] ?? basis;
}
