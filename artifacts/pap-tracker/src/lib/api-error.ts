import { ApiError, ResponseParseError } from "@workspace/api-client-react";

export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof ResponseParseError) {
    return "The API returned an unexpected non-JSON response. Check VITE_API_URL and make sure the frontend is calling the api-server Railway domain.";
  }

  if (error instanceof ApiError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected application error.";
}
