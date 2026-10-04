import { apiUrl } from "@/lib/api";
import type {
  CanonicalFit,
  FittingCharacter,
  FittingAdviceRequest,
  FittingAdviceResponse,
  SavedFitting,
  WorkbenchCatalogItem,
  WorkbenchSimulation,
} from "./fitting-workbench-types";
import { validateFittingAdviceResponse } from "./fitting-ai-advice";
import type { FittingCatalogOptions } from "./fitting-browser-catalog";

export class FittingWorkbenchError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
    this.name = "FittingWorkbenchError";
  }
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const response = await fetch(apiUrl(`/api/fitting${path}`), {
    method: options.method ?? "GET",
    credentials: "include",
    signal: options.signal,
    headers:
      options.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error ?? data?.message;
    throw new FittingWorkbenchError(
      typeof message === "string" &&
        message.length <= 2000 &&
        !/<\/?[a-z!][^>]*>/i.test(message)
        ? message
        : `请求失败（${response.status}），请重试。 / Request failed. Please retry.`,
      response.status,
      data?.code,
    );
  }
  if (data === null)
    throw new FittingWorkbenchError(
      "服务器返回异常，请稍后重试。 / Unexpected server response.",
      response.status,
    );
  return data as T;
}

export const fittingWorkbenchApi = {
  advice: async (body: FittingAdviceRequest, signal: AbortSignal) => {
    const data = await request<unknown>("/advice", { method: "POST", body, signal });
    if (!validateFittingAdviceResponse(data, body))
      throw new FittingWorkbenchError(
        "建议内容未通过检查，请重新生成。 / Advice could not be verified. Please generate it again.",
        502,
        "FITTING_AI_INVALID_OUTPUT",
      );
    return data as FittingAdviceResponse;
  },
  catalog: (
    options: FittingCatalogOptions,
    signal?: AbortSignal,
  ) =>
    request<{ items: WorkbenchCatalogItem[]; sdeBuildNumber: number }>(
      `/catalog?${new URLSearchParams(
        Object.entries(options)
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, String(value)]),
      )}`,
      { signal },
    ),
  simulate: (fit: CanonicalFit, language: string, signal?: AbortSignal) =>
    request<WorkbenchSimulation>("/workbench", {
      method: "POST",
      body: { fit, language },
      signal,
    }),
  import: (text: string, language: string) =>
    request<{ fit: CanonicalFit; warnings: string[] }>("/import", {
      method: "POST",
      body: { text, language },
    }),
  export: (fit: CanonicalFit, language: string) =>
    request<{ text: string; warnings: string[] }>("/export", {
      method: "POST",
      body: { fit, language },
    }),
  saved: (signal?: AbortSignal, cursor?: number) =>
    request<{
      fittings: SavedFitting[];
      nextCursor: number | null;
      canManageCorporation: boolean;
    }>(`/saved?limit=100${cursor === undefined ? "" : `&cursor=${cursor}`}`, {
      signal,
    }),
  create: (body: {
    name: string;
    description: string;
    visibility: "personal" | "corporation";
    fit: CanonicalFit;
  }) => request<{ fitting: SavedFitting }>("/saved", { method: "POST", body }),
  update: (
    id: number,
    body: {
      name: string;
      description: string;
      fit: CanonicalFit;
      version: number;
    },
  ) =>
    request<{ fitting: SavedFitting }>(`/saved/${id}`, { method: "PUT", body }),
  delete: (id: number, version: number) =>
    request<{ deleted: true }>(`/saved/${id}`, {
      method: "DELETE",
      body: { version },
    }),
  characters: (signal?: AbortSignal) =>
    request<{ characters: FittingCharacter[] }>("/characters", { signal }),
};
