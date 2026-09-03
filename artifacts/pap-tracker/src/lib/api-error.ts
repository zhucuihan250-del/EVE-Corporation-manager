import { ApiError, ResponseParseError } from "@workspace/api-client-react";

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function getApiErrorCode(error: unknown): string | undefined {
  if (!(error instanceof ApiError) || !error.data || typeof error.data !== "object") return undefined;
  const code = (error.data as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ResponseParseError) {
    return "服务器返回了异常响应，请稍后重试。 / Unexpected server response. Please try again later.";
  }

  if (error instanceof ApiError) {
    // Proxies and Express can return HTML error pages. Keep the raw response
    // on ApiError for diagnostics, but never display that document to users.
    if (typeof error.data === "string" && /<\/?[a-z!][^>]*>/i.test(error.data)) {
      return `服务器暂时无法处理请求（HTTP ${error.status}），请稍后重试。 / The server could not complete the request. Please try again later.`;
    }
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected application error.";
}
