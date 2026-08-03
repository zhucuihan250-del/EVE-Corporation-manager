import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateReimbursement,
  useGetMe,
  useListCharacters,
  useListReimbursementLosses,
  useListReimbursements,
  useUpdateReimbursement,
  type ReimbursementLoss,
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
import { CheckCircle2, ClipboardCheck, ExternalLink, Loader2, RefreshCw, ShieldCheck } from "lucide-react";

const ROLE_LEVELS = ["member", "fc", "admin", "controller"];
const AUTO_DESCRIPTION = "通过 zKillboard 自动提交";

const formatIsk = (value: number) => `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value)} ISK`;

export function Reimbursements() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const claims = useListReimbursements();
  const characters = useListCharacters();
  const create = useCreateReimbursement();
  const update = useUpdateReimbursement();
  const [characterId, setCharacterId] = useState("");
  const [submittingKillmailId, setSubmittingKillmailId] = useState<number | null>(null);
  const [review, setReview] = useState<Record<number, { status: UpdateReimbursementBodyStatus; approvedAmount: string; reviewerNotes: string; paymentReference: string }>>({});
  const canManage = Boolean(user?.permissions.includes("reimbursement.manage") || ROLE_LEVELS.indexOf(user?.role ?? "member") >= ROLE_LEVELS.indexOf("admin"));
  const selectedCharacter = (characters.data ?? []).find((character) => character.id === Number(characterId));
  const losses = useListReimbursementLosses(
    { characterId: Number(characterId) || 0 },
    { query: { enabled: Boolean(characterId), queryKey: ["reimbursementLosses", Number(characterId) || 0] } },
  );
  const refreshClaims = () => queryClient.invalidateQueries({ queryKey: ["/api/reimbursements"] });

  useEffect(() => {
    if (characterId || !(characters.data?.length)) return;
    const active = characters.data.find((character) => character.eveCharacterId === user?.eveCharacterId) ?? characters.data[0];
    setCharacterId(String(active.id));
  }, [characterId, characters.data, user?.eveCharacterId]);

  const statusLabels = useMemo<Record<string, string>>(() => ({
    submitted: tr("已提交", "Submitted"), reviewing: tr("审核中", "Reviewing"), approved: tr("已批准", "Approved"),
    partially_approved: tr("部分批准", "Partially approved"), rejected: tr("已拒绝", "Rejected"),
    pending_payment: tr("待打款", "Pending payment"), paid: tr("已打款", "Paid"),
  }), [zh]);

  const submitLoss = (loss: ReimbursementLoss) => {
    if (!characterId || loss.alreadySubmitted) return;
    setSubmittingKillmailId(loss.killmailId);
    create.mutate({ data: { characterId: Number(characterId), killmailId: loss.killmailId } }, {
      onSuccess: async () => {
        await Promise.all([refreshClaims(), losses.refetch()]);
        toast({ title: tr("补损申请已提交", "Reimbursement submitted"), description: `${loss.shipName} · ${formatIsk(loss.lossValue)}` });
      },
      onError: (error) => toast({ title: tr("提交失败", "Submission failed"), description: getErrorMessage(error), variant: "destructive" }),
      onSettled: () => setSubmittingKillmailId(null),
    });
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider">{tr("补损", "REIMBURSEMENT")}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {tr("补损不限制舰队，也不填写申请金额；系统直接读取并验证角色在 zKillboard 上的损失。", "Reimbursement is not fleet-restricted and requires no requested amount; losses are read and verified directly from zKillboard.")}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><ClipboardCheck className="h-5 w-5 text-primary" />{tr("选择 zKillboard 损失", "Choose a zKillboard loss")}</CardTitle>
          <CardDescription>{tr(`实名提交人：${user?.eveCharacterName ?? "-"}。选择角色后即可一键提交。`, `Named submitter: ${user?.eveCharacterName ?? "-"}. Select a character and submit a loss with one click.`)}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="space-y-2 flex-1">
              <Label>{tr("损失角色", "Loss character")}</Label>
              <select className="w-full h-10 rounded-md border border-input bg-background px-3" value={characterId} onChange={(event) => setCharacterId(event.target.value)}>
                <option value="">{tr("选择角色", "Select character")}</option>
                {(characters.data ?? []).map((character) => <option key={character.id} value={character.id}>{character.eveCharacterName}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              {selectedCharacter && <Button asChild variant="outline"><a href={`https://zkillboard.com/character/${selectedCharacter.eveCharacterId}/`} target="_blank" rel="noreferrer">zKillboard <ExternalLink className="h-4 w-4 ml-2" /></a></Button>}
              <Button variant="outline" disabled={!characterId || losses.isFetching} onClick={() => losses.refetch()}><RefreshCw className={`h-4 w-4 mr-2 ${losses.isFetching ? "animate-spin" : ""}`} />{tr("刷新损失", "Refresh losses")}</Button>
            </div>
          </div>

          {!characterId ? (
            <p className="text-sm text-muted-foreground">{tr("请选择角色以读取损失记录。", "Select a character to load losses.")}</p>
          ) : losses.isLoading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" />{tr("正在连接 zKillboard 并验证损失…", "Loading and verifying zKillboard losses…")}</div>
          ) : losses.isError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">{getErrorMessage(losses.error)}</div>
          ) : (losses.data ?? []).length === 0 ? (
            <p className="rounded-md border border-border/50 p-4 text-sm text-muted-foreground">{tr("该角色暂时没有可读取的近期损失。", "No recent losses are currently available for this character.")}</p>
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              {(losses.data ?? []).map((loss) => (
                <div key={loss.killmailId} className="flex gap-4 rounded-md border border-border/50 p-4">
                  <img className="h-14 w-14 rounded bg-background object-cover" src={`https://images.evetech.net/types/${loss.shipTypeId}/icon?size=64`} alt="" />
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div><div className="font-medium">{loss.shipName}</div><div className="text-xs text-muted-foreground">{new Date(loss.lossOccurredAt).toLocaleString()} · {formatIsk(loss.lossValue)}</div></div>
                      <a className="inline-flex items-center gap-1 text-xs text-primary hover:underline" href={loss.killmailUrl} target="_blank" rel="noreferrer">zKill <ExternalLink className="h-3 w-3" /></a>
                    </div>
                    <Button className="w-full" disabled={loss.alreadySubmitted || submittingKillmailId !== null} onClick={() => submitLoss(loss)}>
                      {submittingKillmailId === loss.killmailId ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <ShieldCheck className="h-4 w-4 mr-2" />}
                      {loss.alreadySubmitted ? tr(`已提交 · ${statusLabels[loss.claimStatus ?? "submitted"]}`, `Submitted · ${statusLabels[loss.claimStatus ?? "submitted"]}`) : tr("一键提交补损", "Submit reimbursement")}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{canManage ? tr("本军团补损申请", "Corporation reimbursements") : tr("我的补损", "My reimbursements")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {(claims.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无补损申请", "No reimbursement claims")}</p> : (claims.data ?? []).map((claim) => {
            const draft = review[claim.id] ?? { status: claim.status, approvedAmount: claim.approvedAmount?.toString() ?? "", reviewerNotes: claim.reviewerNotes ?? "", paymentReference: claim.paymentReference ?? "" };
            return <div key={claim.id} className="rounded-md border border-border/50 p-4 space-y-3">
              <div className="flex flex-wrap justify-between gap-3"><div><div className="font-medium">{claim.characterName} · {claim.shipName}</div><div className="text-xs text-muted-foreground">{new Date(claim.lossOccurredAt).toLocaleString()} · {tr("zKill 估值", "zKill value")} {formatIsk(claim.lossValue)}</div></div><Badge variant={claim.status === "rejected" ? "destructive" : claim.status === "paid" ? "default" : "outline"}>{statusLabels[claim.status]}</Badge></div>
              {claim.description && claim.description !== AUTO_DESCRIPTION && <p className="text-sm whitespace-pre-wrap">{claim.description}</p>}
              <div className="flex flex-wrap items-center gap-3 text-xs text-emerald-400"><CheckCircle2 className="h-4 w-4" />{claim.validation.message}<a className="inline-flex items-center gap-1 text-primary hover:underline" href={claim.killmailUrl} target="_blank" rel="noreferrer">zKillboard <ExternalLink className="h-3 w-3" /></a></div>
              {claim.reviewerNotes && !canManage && <p className="text-sm text-muted-foreground">{tr("审核记录：", "Review notes: ")}{claim.reviewerNotes}</p>}
              {canManage && <div className="grid gap-2 border-t border-border/50 pt-3 md:grid-cols-2"><select className="h-10 rounded-md border border-input bg-background px-3" value={draft.status} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, status: event.target.value as UpdateReimbursementBodyStatus } }))}>{Object.entries(statusLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select><Input type="number" min="0" placeholder={tr("批准金额", "Approved amount")} value={draft.approvedAmount} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, approvedAmount: event.target.value } }))} /><Textarea placeholder={tr("审核记录", "Review notes")} value={draft.reviewerNotes} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, reviewerNotes: event.target.value } }))} /><div className="space-y-2"><Input placeholder={tr("打款流水号（可选）", "Payment reference (optional)")} value={draft.paymentReference} onChange={(event) => setReview((current) => ({ ...current, [claim.id]: { ...draft, paymentReference: event.target.value } }))} /><Button className="w-full" onClick={() => update.mutate({ id: claim.id, data: { status: draft.status, approvedAmount: draft.approvedAmount ? Number(draft.approvedAmount) : null, reviewerNotes: draft.reviewerNotes, paymentReference: draft.paymentReference } }, { onSuccess: refreshClaims, onError: (error) => toast({ title: getErrorMessage(error), variant: "destructive" }) })}>{tr("保存审核", "Save review")}</Button></div></div>}
            </div>;
          })}
        </CardContent>
      </Card>
    </div>
  );
}
