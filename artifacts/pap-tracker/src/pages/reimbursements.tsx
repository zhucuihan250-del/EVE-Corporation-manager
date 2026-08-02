import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateReimbursement,
  useGetMe,
  useListCharacters,
  useListReimbursementFleets,
  useListReimbursements,
  useUpdateReimbursement,
  type UpdateReimbursementBodyStatus,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { CheckCircle2, ClipboardCheck, ExternalLink, ShieldCheck } from "lucide-react";

const ROLE_LEVELS = ["member", "fc", "admin", "controller"];

const formatIsk = (value: number) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} ISK`;

export function Reimbursements() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const claims = useListReimbursements();
  const fleets = useListReimbursementFleets();
  const characters = useListCharacters();
  const create = useCreateReimbursement();
  const update = useUpdateReimbursement();
  const [form, setForm] = useState({ characterId: "", fleetId: "", killmailUrl: "", requestedAmount: "", description: "" });
  const [review, setReview] = useState<Record<number, { status: UpdateReimbursementBodyStatus; approvedAmount: string; reviewerNotes: string; paymentReference: string }>>({});
  const canManage = Boolean(user?.permissions.includes("reimbursement.manage") || ROLE_LEVELS.indexOf(user?.role ?? "member") >= ROLE_LEVELS.indexOf("admin"));
  const requiresFleet = Boolean(user?.isPrimaryCorporation);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/reimbursements"] });

  const statusLabels = useMemo<Record<string, string>>(() => ({
    submitted: tr("已提交", "Submitted"), reviewing: tr("审核中", "Reviewing"), approved: tr("已批准", "Approved"),
    partially_approved: tr("部分批准", "Partially approved"), rejected: tr("已拒绝", "Rejected"),
    pending_payment: tr("待打款", "Pending payment"), paid: tr("已打款", "Paid"),
  }), [zh]);

  const submit = () => {
    const characterId = Number(form.characterId);
    const requestedAmount = Number(form.requestedAmount);
    if (!characterId || !form.killmailUrl.trim() || !Number.isFinite(requestedAmount) || requestedAmount < 0 || !form.description.trim() || (requiresFleet && !form.fleetId)) {
      toast({ title: tr("请填写完整的补损资料", "Complete all reimbursement details"), variant: "destructive" });
      return;
    }
    create.mutate({ data: {
      characterId,
      fleetId: form.fleetId ? Number(form.fleetId) : null,
      killmailUrl: form.killmailUrl.trim(),
      requestedAmount,
      description: form.description.trim(),
    } }, {
      onSuccess: async () => {
        setForm({ characterId: "", fleetId: "", killmailUrl: "", requestedAmount: "", description: "" });
        await refresh();
        toast({ title: tr("补损申请已提交", "Reimbursement submitted") });
      },
      onError: (error) => toast({ title: tr("提交失败", "Submission failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider">{tr("补损", "REIMBURSEMENT")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {requiresFleet ? tr("请选择允许补损的特定舰队；系统会核验击杀报告、角色与参队记录。", "Choose an eligible fleet; the killmail, character, and participation record are verified.") : tr("本军团不限定舰队；系统仍会核验击杀报告与损失角色。", "No fleet restriction applies to this corporation; killmail and victim ownership are still verified.")}
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-primary" />{tr("提交补损", "Submit reimbursement")}</CardTitle><CardDescription>{tr(`实名提交人：${user?.eveCharacterName ?? "-"}`, `Named submitter: ${user?.eveCharacterName ?? "-"}`)}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><Label>{tr("损失角色", "Loss character")}</Label><select className="w-full h-10 rounded-md border border-input bg-background px-3" value={form.characterId} onChange={(event) => setForm({ ...form, characterId: event.target.value })}><option value="">{tr("选择角色", "Select character")}</option>{(characters.data ?? []).map((character) => <option key={character.id} value={character.id}>{character.eveCharacterName}</option>)}</select></div>
          {requiresFleet && <div className="space-y-2"><Label>{tr("指定舰队", "Eligible fleet")}</Label><select className="w-full h-10 rounded-md border border-input bg-background px-3" value={form.fleetId} onChange={(event) => setForm({ ...form, fleetId: event.target.value })}><option value="">{tr("选择允许补损的舰队", "Select an eligible fleet")}</option>{(fleets.data ?? []).map((fleet) => <option key={fleet.id} value={fleet.id}>{fleet.name} · {fleet.fleetFunction}</option>)}</select></div>}
          <div className="space-y-2"><Label>zKillboard {tr("击杀报告", "killmail")}</Label><Input value={form.killmailUrl} onChange={(event) => setForm({ ...form, killmailUrl: event.target.value })} placeholder="https://zkillboard.com/kill/123456789/" /></div>
          <div className="space-y-2"><Label>{tr("申请金额（ISK）", "Requested amount (ISK)")}</Label><Input type="number" min="0" value={form.requestedAmount} onChange={(event) => setForm({ ...form, requestedAmount: event.target.value })} /></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("损失说明", "Loss description")}</Label><Textarea rows={4} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
          <Button className="md:col-span-2" disabled={create.isPending} onClick={submit}><ShieldCheck className="h-4 w-4 mr-2" />{create.isPending ? tr("验证中…", "Verifying…") : tr("验证并提交", "Verify and submit")}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{canManage ? tr("本军团补损申请", "Corporation reimbursements") : tr("我的补损", "My reimbursements")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {(claims.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无补损申请", "No reimbursement claims")}</p> : (claims.data ?? []).map((claim) => {
            const draft = review[claim.id] ?? { status: claim.status, approvedAmount: claim.approvedAmount?.toString() ?? "", reviewerNotes: claim.reviewerNotes ?? "", paymentReference: claim.paymentReference ?? "" };
            return <div key={claim.id} className="rounded-md border border-border/50 p-4 space-y-3">
              <div className="flex flex-wrap justify-between gap-3"><div><div className="font-medium">{claim.characterName} · {claim.shipName}</div><div className="text-xs text-muted-foreground">{new Date(claim.lossOccurredAt).toLocaleString()} · {tr("损失", "Loss")} {formatIsk(claim.lossValue)} · {tr("申请", "Requested")} {formatIsk(claim.requestedAmount)}</div></div><Badge variant={claim.status === "rejected" ? "destructive" : claim.status === "paid" ? "default" : "outline"}>{statusLabels[claim.status]}</Badge></div>
              <p className="text-sm whitespace-pre-wrap">{claim.description}</p>
              <div className="flex flex-wrap items-center gap-3 text-xs text-emerald-400"><CheckCircle2 className="h-4 w-4" />{claim.validation.message}<a className="inline-flex items-center gap-1 text-primary hover:underline" href={claim.killmailUrl} target="_blank" rel="noreferrer">zKillboard <ExternalLink className="h-3 w-3" /></a></div>
              {claim.reviewerNotes && !canManage && <p className="text-sm text-muted-foreground">{tr("审核记录：", "Review notes: ")}{claim.reviewerNotes}</p>}
              {canManage && <div className="grid gap-2 border-t border-border/50 pt-3 md:grid-cols-2"><select className="h-10 rounded-md border border-input bg-background px-3" value={draft.status} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, status: event.target.value as UpdateReimbursementBodyStatus } }))}>{Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select><Input type="number" min="0" placeholder={tr("批准金额", "Approved amount")} value={draft.approvedAmount} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, approvedAmount: event.target.value } }))} /><Textarea placeholder={tr("审核记录", "Review notes")} value={draft.reviewerNotes} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, reviewerNotes: event.target.value } }))} /><div className="space-y-2"><Input placeholder={tr("打款流水号（可选）", "Payment reference (optional)")} value={draft.paymentReference} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, paymentReference: event.target.value } }))} /><Button className="w-full" onClick={() => update.mutate({ id: claim.id, data: { status: draft.status, approvedAmount: draft.approvedAmount ? Number(draft.approvedAmount) : null, reviewerNotes: draft.reviewerNotes, paymentReference: draft.paymentReference } }, { onSuccess: refresh, onError: (error) => toast({ title: getErrorMessage(error), variant: "destructive" }) })}>{tr("保存审核", "Save review")}</Button></div></div>}
            </div>;
          })}
        </CardContent>
      </Card>
    </div>
  );
}
