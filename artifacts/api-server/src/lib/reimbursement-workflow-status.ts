export type ReimbursementApprovalStatus = "approved" | "partially_approved";

export function determineReimbursementApprovalStatus(
  approvedAmount: number,
  comparisonAmount: number,
): ReimbursementApprovalStatus {
  return approvedAmount + 0.005 >= comparisonAmount ? "approved" : "partially_approved";
}
