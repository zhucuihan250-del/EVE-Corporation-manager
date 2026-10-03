import { apiUrl } from "@/lib/api";

export type PapCurrency = {
  id: number;
  name: string;
  description: string;
  rate: string;
  issuanceEnabled: boolean;
  conversionEnabled: boolean;
  version: number;
  updatedAt: string;
};
export type PapCurrencyWallet = {
  currencyId: number;
  balance: string;
  carry: string;
  version: number;
};
export type PapCurrencyEntry = {
  id: number;
  currencyId: number;
  currencyName: string;
  type: "award" | "adjustment" | "conversion" | "account_merge";
  amount: string;
  rate: string | null;
  commonAmount: string;
  balanceBefore: string;
  balanceAfter: string;
  carryBefore: string;
  carryAfter: string;
  reason: string;
  userName: string;
  createdAt: string;
  requestId: string | null;
};
export type PapWalletData = {
  common: { balance: string; locked: string; available: string };
  wallets: PapCurrencyWallet[];
  currencies: PapCurrency[];
  entries: PapCurrencyEntry[];
};
export type PapConversionPreview = {
  currencyId: number;
  currencyName: string;
  amount: string;
  rate: string;
  commonAmount: string;
  carryBefore: string;
  carryAfter: string;
  balanceAfter: string;
  version: number;
  walletVersion: number;
};
export type PapCurrencyInput = Pick<
  PapCurrency,
  "name" | "description" | "rate" | "issuanceEnabled" | "conversionEnabled"
>;
export type PapCurrencyMember = {
  id: number;
  name: string;
  wallets: PapCurrencyWallet[];
};

export class PapCurrencyError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
    this.name = "PapCurrencyError";
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: options.method ?? "GET",
    credentials: "include",
    headers:
      options.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const raw =
      data && typeof data === "object"
        ? "error" in data
          ? data.error
          : "message" in data
            ? data.message
            : null
        : null;
    throw new PapCurrencyError(
      typeof raw === "string" &&
        raw.length <= 1500 &&
        !/<\/?[a-z!][^>]*>/i.test(raw)
        ? raw
        : `请求失败（HTTP ${response.status}），请刷新后重试。 / Request failed. Refresh and retry.`,
      response.status,
    );
  }
  if (data === null)
    throw new PapCurrencyError(
      "服务器返回异常，请刷新流水核对后重试。 / Unexpected response. Check your ledger before retrying.",
      response.status,
    );
  return data as T;
}

export const papCurrencyKeys = {
  all: ["papCurrencies"] as const,
  currencies: ["papCurrencies", "types"] as const,
  wallet: ["papCurrencies", "wallet"] as const,
  admin: ["papCurrencies", "admin"] as const,
  members: (query: string) => ["papCurrencies", "members", query] as const,
};

export const papCurrencyApi = {
  currencies: (signal?: AbortSignal) =>
    request<{ currencies: PapCurrency[] }>("/api/pap-currencies", { signal }),
  wallet: (signal?: AbortSignal) =>
    request<PapWalletData>("/api/pap-wallet", { signal }),
  preview: (body: { currencyId: number; amount: string }) =>
    request<PapConversionPreview>("/api/pap-wallet/preview", {
      method: "POST",
      body,
    }),
  convert: (body: {
    currencyId: number;
    amount: string;
    version: number;
    walletVersion: number;
    requestId: string;
  }) =>
    request<{ entry: PapCurrencyEntry; replayed: boolean }>(
      "/api/pap-wallet/convert",
      { method: "POST", body },
    ),
  admin: (signal?: AbortSignal) =>
    request<{ currencies: PapCurrency[]; entries: PapCurrencyEntry[] }>(
      "/api/admin/pap-currencies",
      { signal },
    ),
  create: (body: PapCurrencyInput & { requestId: string }) =>
    request<{ currency: PapCurrency }>("/api/admin/pap-currencies", {
      method: "POST",
      body,
    }),
  update: (id: number, body: PapCurrencyInput & { version: number }) =>
    request<{ currency: PapCurrency }>(`/api/admin/pap-currencies/${id}`, {
      method: "PUT",
      body,
    }),
  adjust: (body: {
    currencyId: number;
    userId: number;
    amount: string;
    reason: string;
    version: number;
    requestId: string;
  }) =>
    request<{ entry: PapCurrencyEntry; replayed: boolean }>(
      "/api/admin/pap-currencies/adjust",
      { method: "POST", body },
    ),
  members: (query: string, signal?: AbortSignal) =>
    request<{ members: PapCurrencyMember[] }>(
      `/api/admin/pap-currencies/members?${new URLSearchParams({ query })}`,
      { signal },
    ),
};
