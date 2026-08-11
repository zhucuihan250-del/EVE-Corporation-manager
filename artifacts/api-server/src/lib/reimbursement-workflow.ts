import {
  db,
  reimbursementClaimsTable,
  type ReimbursementClaim,
} from "@workspace/db";
import { and, eq, isNull } from "drizzle-orm";
import { determineReimbursementApprovalStatus } from "./reimbursement-workflow-status";

export const REIMBURSEMENT_WORKFLOW_ACTIONS = [
  "start_review",
  "approve",
  "queue_payment",
  "mark_paid",
  "reject",
] as const;

export type ReimbursementWorkflowAction = typeof REIMBURSEMENT_WORKFLOW_ACTIONS[number];

type WorkflowBody = {
  action?: unknown;
  status?: unknown;
  approvedAmount?: unknown;
  reviewerNotes?: unknown;
  paymentReference?: unknown;
};

type WorkflowScope = {
  corporationId: number;
  claimId: number;
  reviewerId: number;
  identityGroupId?: number | null;
};

export class ReimbursementWorkflowError extends Error {
  readonly statusCode: number;

  constructor(
    message: string,
    statusCode: number,
  ) {
    super(message);
    this.statusCode = statusCode;
  }
}

function normalizeText(value: unknown, maximumLength: number): string | null {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, maximumLength)
    : null;
}

function resolveAction(body: WorkflowBody): ReimbursementWorkflowAction | "keep_submitted" {
  if (typeof body.action === "string" && REIMBURSEMENT_WORKFLOW_ACTIONS.includes(body.action as ReimbursementWorkflowAction)) {
    return body.action as ReimbursementWorkflowAction;
  }

  // Preserve the existing status field for older clients while routing it through
  // the same guarded workflow. The server, not the requested status, decides
  // whether an approval is full or partial.
  switch (body.status) {
    case "submitted": return "keep_submitted";
    case "reviewing": return "start_review";
    case "approved":
    case "partially_approved": return "approve";
    case "pending_payment": return "queue_payment";
    case "paid": return "mark_paid";
    case "rejected": return "reject";
    default: throw new ReimbursementWorkflowError("请选择有效的补损处理动作", 400);
  }
}

function parseApprovedAmount(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new ReimbursementWorkflowError("批准金额无效", 400);
  }
  return amount;
}

function referenceComparisonAmount(claim: ReimbursementClaim): number {
  if (
    claim.referencePriceStatus === "calculated"
    && claim.referenceReimbursementAmount !== null
  ) {
    return claim.referenceReimbursementAmount;
  }
  return claim.lossValue;
}

function ensureStatus(
  claim: ReimbursementClaim,
  allowed: ReimbursementClaim["status"][],
  actionLabel: string,
): void {
  if (!allowed.includes(claim.status)) {
    throw new ReimbursementWorkflowError(`当前状态不能${actionLabel}，请刷新后重试`, 409);
  }
}

export async function updateReimbursementWorkflow(scope: WorkflowScope, body: WorkflowBody) {
  const filters = [
    eq(reimbursementClaimsTable.id, scope.claimId),
    eq(reimbursementClaimsTable.corporationId, scope.corporationId),
  ];
  if (scope.identityGroupId === null) filters.push(isNull(reimbursementClaimsTable.identityGroupId));
  if (typeof scope.identityGroupId === "number") filters.push(eq(reimbursementClaimsTable.identityGroupId, scope.identityGroupId));

  const [claim] = await db.select().from(reimbursementClaimsTable).where(and(...filters));
  if (!claim) throw new ReimbursementWorkflowError("Reimbursement claim not found", 404);

  const action = resolveAction(body);
  const suppliedApprovedAmount = parseApprovedAmount(body.approvedAmount);
  const reviewerNotes = body.reviewerNotes === undefined
    ? claim.reviewerNotes
    : normalizeText(body.reviewerNotes, 10_000);
  let status = claim.status;
  let approvedAmount = claim.approvedAmount;
  let paymentReference = claim.paymentReference;
  let paidAt = claim.paidAt;

  switch (action) {
    case "keep_submitted":
      ensureStatus(claim, ["submitted"], "保持为已提交");
      break;
    case "start_review":
      ensureStatus(claim, ["submitted", "reviewing"], "开始审核");
      status = "reviewing";
      paymentReference = null;
      paidAt = null;
      break;
    case "approve": {
      ensureStatus(claim, ["submitted", "reviewing", "approved", "partially_approved"], "确认审核结果");
      if (suppliedApprovedAmount === null || suppliedApprovedAmount <= 0) {
        throw new ReimbursementWorkflowError("批准申请时必须填写大于 0 的批准金额", 400);
      }
      const comparisonAmount = referenceComparisonAmount(claim);
      status = determineReimbursementApprovalStatus(suppliedApprovedAmount, comparisonAmount);
      approvedAmount = suppliedApprovedAmount;
      paymentReference = null;
      paidAt = null;
      break;
    }
    case "queue_payment":
      ensureStatus(claim, ["approved", "partially_approved", "pending_payment"], "转入待打款");
      if (claim.approvedAmount === null || claim.approvedAmount <= 0) {
        throw new ReimbursementWorkflowError("缺少有效的批准金额，无法转入待打款", 409);
      }
      status = "pending_payment";
      paymentReference = null;
      paidAt = null;
      break;
    case "mark_paid": {
      ensureStatus(claim, ["pending_payment", "paid"], "确认打款");
      const suppliedPaymentReference = normalizeText(body.paymentReference, 500);
      paymentReference = suppliedPaymentReference ?? claim.paymentReference;
      if (!paymentReference) {
        throw new ReimbursementWorkflowError("确认打款时必须填写打款流水号或凭证", 400);
      }
      status = "paid";
      paidAt = claim.paidAt ?? new Date();
      break;
    }
    case "reject":
      ensureStatus(claim, ["submitted", "reviewing", "approved", "partially_approved", "pending_payment", "rejected"], "拒绝申请");
      if (!reviewerNotes) {
        throw new ReimbursementWorkflowError("拒绝申请时必须填写审核说明", 400);
      }
      status = "rejected";
      approvedAmount = null;
      paymentReference = null;
      paidAt = null;
      break;
  }

  const [updated] = await db.update(reimbursementClaimsTable).set({
    status,
    approvedAmount,
    reviewerNotes,
    paymentReference,
    reviewedBy: scope.reviewerId,
    reviewedAt: new Date(),
    paidAt,
  }).where(and(
    ...filters,
    eq(reimbursementClaimsTable.status, claim.status),
  )).returning();

  if (!updated) {
    throw new ReimbursementWorkflowError("补损状态已被其他审核操作更新，请刷新后重试", 409);
  }
  return updated;
}
