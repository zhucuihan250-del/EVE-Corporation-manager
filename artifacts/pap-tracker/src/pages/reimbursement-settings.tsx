import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getListReimbursementWindowClaimsQueryKey,
  useGetMe,
  useListReimbursementWindowClaims,
  useRefreshReimbursementReferencePricing,
  useUpdateReimbursementWindow,
  useUpdateReimbursementWindowClaim,
  type CurrentUser,
  type ReimbursementClaim,
  type UpdateReimbursementBodyAction,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { Calculator, CheckCircle2, CircleDollarSign, ExternalLink, Layers3, Loader2, LockKeyhole, PlayCircle, ReceiptText, RefreshCw, Send, TriangleAlert, UnlockKeyhole, XCircle } from "lucide-react";

const AUTO_DESCRIPTION = "通过 zKillboard 自动提交";
const formatIsk = (value: number) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value)} ISK`;

export function ReimbursementSettings() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { data: user } = useGetMe();
  const claims = useListReimbursementWindowClaims();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const updateWindow = useUpdateReimbursementWindow();
  const updateClaim = useUpdateReimbursementWindowClaim();
  const refreshReferencePricing = useRefreshReimbursementReferencePricing();
  const isOpen = user?.reimbursementOpen !== false;
  const canManageWindow = Boolean(user?.permissions.includes("reimbursement.window.manage"));
  const [scope, setScope] = useState<"all" | "general" | "tactical">("all");
  const [pricingClaimId, setPricingClaimId] = useState<number | null>(null);
  const [workflowClaimId, setWorkflowClaimId] = useState<number | null>(null);
  const [review, setReview] = useState<Record<number, { approvedAmount: string; reviewerNotes: string; paymentReference: string }>>({});

  const statusLabels = useMemo<Record<string, string>>(() => ({
    submitted: tr("已提交", "Submitted"), reviewing: tr("审核中", "Reviewing"), approved: tr("已批准", "Approved"),
    partially_approved: tr("部分批准", "Partially approved"), rejected: tr("已拒绝", "Rejected"),
    pending_payment: tr("待打款", "Pending payment"), paid: tr("已打款", "Paid"),
  }), [zh]);
  const allClaims = claims.data ?? [];
  const visibleClaims = allClaims.filter((claim) => scope === "all" || (scope === "general" ? claim.identityGroupId === null : claim.identityGroupId !== null));
  const pendingCount = allClaims.filter((claim) => !["rejected", "paid"].includes(claim.status)).length;
  const tacticalCount = allClaims.filter((claim) => claim.identityGroupId !== null).length;
  const paidCount = allClaims.filter((claim) => claim.status === "paid").length;
  const refreshClaims = () => queryClient.invalidateQueries({ queryKey: getListReimbursementWindowClaimsQueryKey() });

  const toggleWindow = () => {
    updateWindow.mutate({ data: { open: !isOpen } }, {
      onSuccess: (result) => {
        queryClient.setQueryData<CurrentUser>(getGetMeQueryKey(), (current) => (
          current ? { ...current, reimbursementOpen: result.open } : current
        ));
        toast({
          title: result.open ? tr("补损窗口已开启", "Reimbursement window opened") : tr("补损窗口已关闭", "Reimbursement window closed"),
          description: tr(`设置仅作用于 ${user?.corporationName ?? "当前军团"}。`, `This setting only affects ${user?.corporationName ?? "the current corporation"}.`),
        });
      },
      onError: (error) => toast({ title: tr("操作失败", "Update failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const advanceWorkflow = (claim: ReimbursementClaim, action: UpdateReimbursementBodyAction) => {
    const draft = review[claim.id] ?? {
      approvedAmount: claim.approvedAmount?.toString() ?? claim.referenceReimbursementAmount?.toString() ?? "",
      reviewerNotes: claim.reviewerNotes ?? "",
      paymentReference: claim.paymentReference ?? "",
    };
    if (action === "approve" && (!draft.approvedAmount || Number(draft.approvedAmount) <= 0)) {
      toast({ title: tr("请填写有效的批准金额", "Enter a valid approved amount"), variant: "destructive" });
      return;
    }
    if (action === "reject" && !draft.reviewerNotes.trim()) {
      toast({ title: tr("拒绝申请前请填写审核说明", "Add review notes before rejecting"), variant: "destructive" });
      return;
    }
    if (action === "mark_paid" && !draft.paymentReference.trim()) {
      toast({ title: tr("确认打款前请填写流水号或凭证", "Add a payment reference before marking paid"), variant: "destructive" });
      return;
    }
    setWorkflowClaimId(claim.id);
    updateClaim.mutate({
      id: claim.id,
      data: {
        action,
        approvedAmount: action === "approve" ? Number(draft.approvedAmount) : undefined,
        reviewerNotes: draft.reviewerNotes,
        paymentReference: action === "mark_paid" ? draft.paymentReference : undefined,
      },
    }, {
      onSuccess: async () => {
        setReview((current) => {
          const next = { ...current };
          delete next[claim.id];
          return next;
        });
        await refreshClaims();
        const titles: Record<UpdateReimbursementBodyAction, string> = {
          start_review: tr("申请已进入审核", "Claim moved to review"),
          approve: tr("审核结果已自动确定", "Approval status determined"),
          queue_payment: tr("申请已转入待打款", "Claim queued for payment"),
          mark_paid: tr("申请已标记为已打款", "Claim marked paid"),
          reject: tr("申请已拒绝", "Claim rejected"),
        };
        toast({ title: titles[action] });
      },
      onError: (error) => toast({ title: tr("处理失败", "Workflow update failed"), description: getErrorMessage(error), variant: "destructive" }),
      onSettled: () => setWorkflowClaimId(null),
    });
  };

  const refreshReference = (claimId: number) => {
    setPricingClaimId(claimId);
    refreshReferencePricing.mutate({ id: claimId }, {
      onSuccess: async () => {
        await refreshClaims();
        toast({ title: tr("参考补损额已更新", "Reference reimbursement updated") });
      },
      onError: (error) => toast({ title: tr("估价失败", "Pricing failed"), description: getErrorMessage(error), variant: "destructive" }),
      onSettled: () => setPricingClaimId(null),
    });
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider">{tr("补损窗口与统一审核", "REIMBURSEMENT WINDOW & REVIEW")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{tr("总监在此管理所属军团的补损入口，并集中查看和审核全部通用补损与身份组专属补损。", "Directors manage the corporation window and review every general and tactical-group claim here.")}</p>
      </div>

      <Card className={isOpen ? "border-emerald-500/40" : "border-zinc-600/60"}>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5"><CardTitle className="flex items-center gap-2">{isOpen ? <UnlockKeyhole className="h-5 w-5 text-emerald-400" /> : <LockKeyhole className="h-5 w-5 text-muted-foreground" />}{user?.corporationName}</CardTitle><CardDescription>{isOpen ? tr("成员目前可以进入补损并提交 zKillboard 损失。", "Members can currently access reimbursement and submit zKillboard losses.") : tr("成员补损入口已关闭；总监仍可在下方审核已有请求。", "Member submissions are closed; Directors can still review existing claims below.")}</CardDescription></div>
            <Badge variant={isOpen ? "default" : "secondary"}>{isOpen ? tr("已开启", "Open") : tr("已关闭", "Closed")}</Badge>
          </div>
        </CardHeader>
        <CardContent>{canManageWindow ? <Button variant={isOpen ? "destructive" : "default"} disabled={updateWindow.isPending} onClick={toggleWindow}>{updateWindow.isPending ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : isOpen ? <LockKeyhole className="h-4 w-4 mr-2" /> : <UnlockKeyhole className="h-4 w-4 mr-2" />}{isOpen ? tr("关闭本军团补损", "Close corporation reimbursement") : tr("开启本军团补损", "Open corporation reimbursement")}</Button> : <p className="text-sm text-muted-foreground">{tr("您可以审核全部补损请求；只有补损窗口管理权限可以开启或关闭成员入口。", "You can review all claims; opening or closing member submissions requires reimbursement-window permission.")}</p>}</CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{tr("全部请求", "All claims")}</div><div className="mt-1 text-2xl font-bold">{allClaims.length}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{tr("待处理", "Open")}</div><div className="mt-1 text-2xl font-bold text-amber-400">{pendingCount}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{tr("身份组专属", "Tactical")}</div><div className="mt-1 text-2xl font-bold text-violet-300">{tacticalCount}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{tr("已打款", "Paid")}</div><div className="mt-1 text-2xl font-bold text-emerald-400">{paidCount}</div></CardContent></Card>
      </div>

      <Card>
        <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><ReceiptText className="h-5 w-5 text-primary" />{tr("全军团补损请求", "All corporation reimbursement claims")}</CardTitle><CardDescription>{tr("状态由审核动作自动流转；全额或部分批准会比较完整参考补损额，参考估价不完整时回退到已验证损失估值。", "Statuses advance automatically; full or partial approval uses a complete reference amount, falling back to the verified loss value when reference pricing is incomplete.")}</CardDescription></div><div className="flex gap-2">{(["all", "general", "tactical"] as const).map((value) => <Button key={value} size="sm" variant={scope === value ? "default" : "outline"} onClick={() => setScope(value)}>{value === "all" ? tr("全部", "All") : value === "general" ? tr("通用", "General") : tr("身份组", "Tactical")}</Button>)}</div></div></CardHeader>
        <CardContent className="space-y-4">
          {claims.isLoading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{tr("正在读取补损请求…", "Loading claims…")}</div> : claims.isError ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{getErrorMessage(claims.error)}</div> : visibleClaims.length === 0 ? <p className="text-sm text-muted-foreground">{tr("当前分类暂无补损请求", "No claims in this category")}</p> : visibleClaims.map((claim) => {
            const draft = review[claim.id] ?? { approvedAmount: claim.approvedAmount?.toString() ?? claim.referenceReimbursementAmount?.toString() ?? "", reviewerNotes: claim.reviewerNotes ?? "", paymentReference: claim.paymentReference ?? "" };
            const approvalComparisonAmount = claim.referencePriceStatus === "calculated" && claim.referenceReimbursementAmount != null ? claim.referenceReimbursementAmount : claim.lossValue;
            return <div key={claim.id} className="space-y-3 rounded-md border border-border/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2 font-medium"><span>#{claim.id} · {claim.characterName} · {claim.shipName}</span><Badge variant={claim.identityGroupId ? "secondary" : "outline"}><Layers3 className="mr-1 h-3 w-3" />{claim.identityGroupName ?? tr("通用补损", "General")}</Badge></div><div className="mt-1 text-xs text-muted-foreground">{new Date(claim.lossOccurredAt).toLocaleString()} · {tr("提交于", "submitted")} {new Date(claim.createdAt).toLocaleString()} · {formatIsk(claim.lossValue)}</div></div><Badge variant={claim.status === "rejected" ? "destructive" : claim.status === "paid" ? "default" : "outline"}>{statusLabels[claim.status]}</Badge></div>
              {claim.description && claim.description !== AUTO_DESCRIPTION && <p className="whitespace-pre-wrap text-sm">{claim.description}</p>}
              <div className="flex flex-wrap items-center gap-3 text-xs text-emerald-400"><CheckCircle2 className="h-4 w-4" />{claim.validation.message}<a className="inline-flex items-center gap-1 text-primary hover:underline" href={claim.killmailUrl} target="_blank" rel="noreferrer">zKillboard <ExternalLink className="h-3 w-3" /></a></div>
              <div className="space-y-3 rounded-md border border-primary/30 bg-primary/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 text-sm font-medium"><Calculator className="h-4 w-4 text-primary" />{tr("参考补损额", "Reference reimbursement")}</div>
                    <div className="mt-1 text-xl font-bold">
                      {claim.referencePriceStatus === "pending"
                        ? tr("等待自动估价", "Awaiting automatic pricing")
                        : claim.referencePriceStatus === "unavailable"
                          ? tr("暂无可用估价", "No price available")
                          : formatIsk(claim.referenceReimbursementAmount ?? 0)}
                    </div>
                  </div>
                  <Button size="sm" variant="outline" disabled={pricingClaimId !== null} onClick={() => refreshReference(claim.id)}>
                    {pricingClaimId === claim.id ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                    {claim.referencePriceStatus === "pending" ? tr("立即计算", "Calculate now") : tr("刷新价格", "Refresh prices")}
                  </Button>
                </div>
                {claim.jitaMidValue !== null && claim.maximumInsurancePayout !== null && (
                  <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
                    <div><span className="block">{tr("损失 Jita 中间价", "Jita midpoint loss")}</span><span className="text-sm font-medium text-foreground">{formatIsk(claim.jitaMidValue)}</span></div>
                    <div><span className="block">{tr("减：舰船最高保险赔付", "Less: maximum ship insurance")}</span><span className="text-sm font-medium text-foreground">− {formatIsk(claim.maximumInsurancePayout)}</span></div>
                    <div><span className="block">{tr("参考补损额", "Reference reimbursement")}</span><span className="text-sm font-medium text-primary">= {formatIsk(claim.referenceReimbursementAmount ?? 0)}</span></div>
                  </div>
                )}
                {(claim.referencePriceStatus === "partial" || claim.referencePriceStatus === "unavailable") && (
                  <div className="flex items-start gap-2 text-xs text-amber-400"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />{claim.referencePriceStatus === "unavailable" ? tr("全部损失物品都缺少可用的 Jita 4-4 订单，暂时无法估价。", "No lost items have usable Jita 4-4 orders, so pricing is currently unavailable.") : tr(`有 ${claim.referencePriceMissingTypeCount} 类损失物品缺少完整的 Jita 4-4 双边订单，当前结果为部分估价。`, `${claim.referencePriceMissingTypeCount} lost item types lack complete two-sided Jita 4-4 orders; this is a partial estimate.`)}</div>
                )}
                <p className="text-xs text-muted-foreground">{tr("计算口径：舰船与全部损失物品按 Jita 4-4 最高收购价和最低出售价的中间值计价，再减去该舰船最高档保险的赔付；仅供审核参考，不会自动修改批准金额。", "Method: price the hull and all lost items at the midpoint of Jita 4-4 best buy and best sell, then subtract the ship's highest insurance payout. This is advisory and never changes the approved amount automatically.")}{claim.referencePriceCalculatedAt && <> · {tr("更新于", "updated")} {new Date(claim.referencePriceCalculatedAt).toLocaleString()}</>}</p>
              </div>
              {claim.status !== "rejected" && claim.status !== "paid" && <div className="space-y-3 border-t border-border/50 pt-3">
                <Textarea placeholder={tr("审核说明；拒绝申请时必填", "Review notes; required when rejecting")} value={draft.reviewerNotes} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, reviewerNotes: event.target.value } }))} />
                {["submitted", "reviewing", "approved", "partially_approved"].includes(claim.status) && <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                  <div className="space-y-1"><Input type="number" min="0" placeholder={tr("批准金额", "Approved amount")} value={draft.approvedAmount} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, approvedAmount: event.target.value } }))} /><p className="text-xs text-muted-foreground">{tr(`系统比较基准：${formatIsk(approvalComparisonAmount)}`, `Automatic comparison baseline: ${formatIsk(approvalComparisonAmount)}`)}</p></div>
                  <Button disabled={workflowClaimId !== null} onClick={() => advanceWorkflow(claim, "approve")}><CheckCircle2 className="mr-2 h-4 w-4" />{claim.status === "approved" || claim.status === "partially_approved" ? tr("更新审核结果", "Update approval") : tr("确认审核结果", "Confirm approval")}</Button>
                </div>}
                {claim.status === "pending_payment" && <div className="grid gap-2 md:grid-cols-[1fr_auto]">
                  <Input placeholder={tr("打款流水号或凭证（必填）", "Payment reference (required)")} value={draft.paymentReference} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, paymentReference: event.target.value } }))} />
                  <Button disabled={workflowClaimId !== null} onClick={() => advanceWorkflow(claim, "mark_paid")}><CircleDollarSign className="mr-2 h-4 w-4" />{tr("确认已打款", "Confirm paid")}</Button>
                </div>}
                <div className="flex flex-wrap gap-2">
                  {(claim.status === "submitted" || claim.status === "reviewing") && <Button variant="outline" disabled={workflowClaimId !== null} onClick={() => advanceWorkflow(claim, "start_review")}><PlayCircle className="mr-2 h-4 w-4" />{claim.status === "submitted" ? tr("开始审核", "Start review") : tr("保存审核记录", "Save review notes")}</Button>}
                  {(claim.status === "approved" || claim.status === "partially_approved") && <Button disabled={workflowClaimId !== null} onClick={() => advanceWorkflow(claim, "queue_payment")}><Send className="mr-2 h-4 w-4" />{tr("转入待打款", "Queue payment")}</Button>}
                  <Button variant="destructive" disabled={workflowClaimId !== null} onClick={() => advanceWorkflow(claim, "reject")}><XCircle className="mr-2 h-4 w-4" />{tr("拒绝申请", "Reject claim")}</Button>
                </div>
              </div>}
              {["rejected", "paid"].includes(claim.status) && <div className="space-y-1 border-t border-border/50 pt-3 text-sm text-muted-foreground">{claim.approvedAmount != null && <p>{tr("批准金额：", "Approved amount: ")}{formatIsk(claim.approvedAmount)}</p>}{claim.reviewerNotes && <p>{tr("审核记录：", "Review notes: ")}{claim.reviewerNotes}</p>}{claim.paymentReference && <p>{tr("打款凭证：", "Payment reference: ")}{claim.paymentReference}</p>}</div>}
            </div>;
          })}
        </CardContent>
      </Card>
    </div>
  );
}
