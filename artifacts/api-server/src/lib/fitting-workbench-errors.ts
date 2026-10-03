export class FittingWorkbenchError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "FittingWorkbenchError";
  }
}

export type FittingActor = { corporationId: number; userId: number; userName: string; role: string; permissions: string[] };

export function fittingObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FittingWorkbenchError(400, "FITTING_INVALID_INPUT", "配装请求须为有效对象。");
  }
  return value as Record<string, unknown>;
}

export function fittingId(value: unknown): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || Number(number) <= 0) {
    throw new FittingWorkbenchError(400, "FITTING_INVALID_ID", "配装或角色编号无效。");
  }
  return Number(number);
}

export function fittingVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) >= 2_147_483_647) {
    throw new FittingWorkbenchError(400, "FITTING_INVALID_VERSION", "请提供当前配置版本后重试。");
  }
  return Number(value);
}
