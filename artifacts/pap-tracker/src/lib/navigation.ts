import type { CurrentUser } from "@workspace/api-client-react";

const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;

export const REIMBURSEMENT_REVIEW_PERMISSIONS = [
  "reimbursement.manage",
  "reimbursement.window.manage",
] as const;

export type Role = (typeof ROLE_LEVELS)[number];

export function hasRole(userRole: string, minRole: Role): boolean {
  return ROLE_LEVELS.indexOf(userRole as Role) >= ROLE_LEVELS.indexOf(minRole);
}

export function defaultLanding(user: CurrentUser): string {
  if (user.modules.pap) return "/dashboard";
  if (user.modules.reimbursement && user.reimbursementOpen) return "/reimbursements";
  if (
    user.modules.reimbursement
    && REIMBURSEMENT_REVIEW_PERMISSIONS.some((permission) => user.permissions.includes(permission))
  ) {
    return "/reimbursement-settings";
  }
  if (user.modules.diplomacy) return "/diplomacy";
  if (user.modules.courier) return "/courier";
  if (user.modules.structures && hasRole(user.role, "admin")) return "/structures";
  return "/";
}
