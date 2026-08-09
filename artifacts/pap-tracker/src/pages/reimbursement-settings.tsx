import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getListReimbursementWindowClaimsQueryKey,
  useGetMe,
  useListReimbursementWindowClaims,
  useUpdateReimbursementWindow,
  useUpdateReimbursementWindowClaim,
  type CurrentUser,
  type UpdateReimbursementBodyStatus,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { CheckCircle2, ExternalLink, Layers3, Loader2, LockKeyhole, ReceiptText, UnlockKeyhole } from "lucide-react";

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
  const isOpen = user?.reimbursementOpen !== false;
  const canManageWindow = Boolean(user?.permissions.includes("reimbursement.window.manage"));
  const [scope, setScope] = useState<"all" | "general" | "tactical">("all");
  const [review, setReview] = useState<Record<number, { status: UpdateReimbursementBodyStatus; approvedAmount: string; reviewerNotes: string; paymentReference: string }>>({});

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

  const saveReview = (claimId: number, currentStatus: UpdateReimbursementBodyStatus, currentApprovedAmount: number | null, currentReviewerNotes: string | null, currentPaymentReference: string | null) => {
    const draft = review[claimId] ?? { status: currentStatus, approvedAmount: currentApprovedAmount?.toString() ?? "", reviewerNotes: currentReviewerNotes ?? "", paymentReference: currentPaymentReference ?? "" };
    updateClaim.mutate({ id: claimId, data: { status: draft.status, approvedAmount: draft.approvedAmount ? Number(draft.approvedAmount) : null, reviewerNotes: draft.reviewerNotes, paymentReference: draft.paymentReference } }, {
      onSuccess: async () => { await refreshClaims(); toast({ title: tr("补损审核已保存", "Reimbursement review saved") }); },
      onError: (error) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" }),
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
        <CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle className="flex items-center gap-2"><ReceiptText className="h-5 w-5 text-primary" />{tr("全军团补损请求", "All corporation reimbursement claims")}</CardTitle><CardDescription>{tr("身份组补损与通用补损在此统一审核，仍保持其原有分类。", "General and tactical claims are reviewed together while retaining their original classification.")}</CardDescription></div><div className="flex gap-2">{(["all", "general", "tactical"] as const).map((value) => <Button key={value} size="sm" variant={scope === value ? "default" : "outline"} onClick={() => setScope(value)}>{value === "all" ? tr("全部", "All") : value === "general" ? tr("通用", "General") : tr("身份组", "Tactical")}</Button>)}</div></div></CardHeader>
        <CardContent className="space-y-4">
          {claims.isLoading ? <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{tr("正在读取补损请求…", "Loading claims…")}</div> : claims.isError ? <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{getErrorMessage(claims.error)}</div> : visibleClaims.length === 0 ? <p className="text-sm text-muted-foreground">{tr("当前分类暂无补损请求", "No claims in this category")}</p> : visibleClaims.map((claim) => {
            const draft = review[claim.id] ?? { status: claim.status, approvedAmount: claim.approvedAmount?.toString() ?? "", reviewerNotes: claim.reviewerNotes ?? "", paymentReference: claim.paymentReference ?? "" };
            return <div key={claim.id} className="space-y-3 rounded-md border border-border/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex flex-wrap items-center gap-2 font-medium"><span>#{claim.id} · {claim.characterName} · {claim.shipName}</span><Badge variant={claim.identityGroupId ? "secondary" : "outline"}><Layers3 className="mr-1 h-3 w-3" />{claim.identityGroupName ?? tr("通用补损", "General")}</Badge></div><div className="mt-1 text-xs text-muted-foreground">{new Date(claim.lossOccurredAt).toLocaleString()} · {tr("提交于", "submitted")} {new Date(claim.createdAt).toLocaleString()} · {formatIsk(claim.lossValue)}</div></div><Badge variant={claim.status === "rejected" ? "destructive" : claim.status === "paid" ? "default" : "outline"}>{statusLabels[claim.status]}</Badge></div>
              {claim.description && claim.description !== AUTO_DESCRIPTION && <p className="whitespace-pre-wrap text-sm">{claim.description}</p>}
              <div className="flex flex-wrap items-center gap-3 text-xs text-emerald-400"><CheckCircle2 className="h-4 w-4" />{claim.validation.message}<a className="inline-flex items-center gap-1 text-primary hover:underline" href={claim.killmailUrl} target="_blank" rel="noreferrer">zKillboard <ExternalLink className="h-3 w-3" /></a></div>
              <div className="grid gap-2 border-t border-border/50 pt-3 md:grid-cols-2"><select className="h-10 rounded-md border border-input bg-background px-3" value={draft.status} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, status: event.target.value as UpdateReimbursementBodyStatus } }))}>{Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select><Input type="number" min="0" placeholder={tr("批准金额", "Approved amount")} value={draft.approvedAmount} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, approvedAmount: event.target.value } }))} /><Textarea placeholder={tr("审核记录", "Review notes")} value={draft.reviewerNotes} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, reviewerNotes: event.target.value } }))} /><div className="space-y-2"><Input placeholder={tr("打款流水号（可选）", "Payment reference (optional)")} value={draft.paymentReference} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, paymentReference: event.target.value } }))} /><Button className="w-full" disabled={updateClaim.isPending} onClick={() => saveReview(claim.id, claim.status, claim.approvedAmount ?? null, claim.reviewerNotes ?? null, claim.paymentReference ?? null)}>{tr("保存审核", "Save review")}</Button></div></div>
            </div>;
          })}
        </CardContent>
      </Card>
    </div>
  );
}
