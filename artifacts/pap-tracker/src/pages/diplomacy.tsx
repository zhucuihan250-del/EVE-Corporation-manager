import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useCreateDiplomacyCase,
  useGetMe,
  useListDiplomacyCases,
  useUpdateDiplomacyCase,
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
import { Handshake, LockKeyhole, Send } from "lucide-react";

const ROLE_LEVELS = ["member", "fc", "admin", "controller"];

export function Diplomacy() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const cases = useListDiplomacyCases();
  const create = useCreateDiplomacyCase();
  const update = useUpdateDiplomacyCase();
  const [form, setForm] = useState({ category: "other", counterparty: "", subject: "", description: "", evidenceUrl: "", urgency: "normal" });
  const [notes, setNotes] = useState<Record<number, string>>({});
  const canManage = Boolean(user?.permissions.includes("diplomacy.manage") || ROLE_LEVELS.indexOf(user?.role ?? "member") >= ROLE_LEVELS.indexOf("admin"));
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/diplomacy"] });

  const statusLabels: Record<string, string> = {
    submitted: tr("已提交", "Submitted"), accepted: tr("已受理", "Accepted"), investigating: tr("调查中", "Investigating"),
    waiting: tr("等待回复", "Waiting"), resolved: tr("已解决", "Resolved"), rejected: tr("已驳回", "Rejected"), closed: tr("已关闭", "Closed"),
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div><h1 className="text-2xl font-bold font-mono tracking-wider">{tr("外交事务", "DIPLOMACY")}</h1><p className="text-sm text-muted-foreground mt-1">{tr("实名提交并在本军团内处理，其他军团完全不可见。", "Named submissions are handled inside this corporation and are invisible to other corporations.")}</p></div>
      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Handshake className="h-5 w-5 text-primary" />{tr("提交外交问题", "Submit diplomacy case")}</CardTitle><CardDescription className="flex items-center gap-2"><LockKeyhole className="h-4 w-4" />{tr(`提交人：${user?.eveCharacterName ?? "-"}（不支持匿名）`, `Submitter: ${user?.eveCharacterName ?? "-"} (anonymous submissions are not allowed)`)}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><Label>{tr("问题类型", "Category")}</Label><select className="w-full h-10 rounded-md border border-input bg-background px-3" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}><option value="standings">{tr("关系与声望", "Standings")}</option><option value="conflict">{tr("冲突事件", "Conflict")}</option><option value="cooperation">{tr("合作", "Cooperation")}</option><option value="compensation">{tr("赔偿", "Compensation")}</option><option value="complaint">{tr("投诉", "Complaint")}</option><option value="other">{tr("其他", "Other")}</option></select></div>
          <div className="space-y-2"><Label>{tr("紧急程度", "Urgency")}</Label><select className="w-full h-10 rounded-md border border-input bg-background px-3" value={form.urgency} onChange={(event) => setForm({ ...form, urgency: event.target.value })}><option value="normal">{tr("普通", "Normal")}</option><option value="high">{tr("较高", "High")}</option><option value="urgent">{tr("紧急", "Urgent")}</option></select></div>
          <div className="space-y-2"><Label>{tr("相关军团、联盟或联系人", "Corporation, alliance, or contact")}</Label><Input value={form.counterparty} onChange={(event) => setForm({ ...form, counterparty: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("主题", "Subject")}</Label><Input value={form.subject} onChange={(event) => setForm({ ...form, subject: event.target.value })} /></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("详细经过", "Details")}</Label><Textarea rows={5} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("证据链接（可选）", "Evidence URL (optional)")}</Label><Input value={form.evidenceUrl} onChange={(event) => setForm({ ...form, evidenceUrl: event.target.value })} /></div>
          <Button className="md:col-span-2" disabled={create.isPending} onClick={() => create.mutate({ data: { category: form.category as never, counterparty: form.counterparty, subject: form.subject, description: form.description, evidenceUrl: form.evidenceUrl, urgency: form.urgency as never } }, { onSuccess: async () => { setForm({ category: "other", counterparty: "", subject: "", description: "", evidenceUrl: "", urgency: "normal" }); await refresh(); toast({ title: tr("外交问题已提交", "Diplomacy case submitted") }); }, onError: (error) => toast({ title: tr("提交失败", "Submission failed"), description: getErrorMessage(error), variant: "destructive" }) })}><Send className="h-4 w-4 mr-2" />{tr("提交", "Submit")}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{canManage ? tr("本军团外交问题", "Corporation diplomacy cases") : tr("我的外交问题", "My diplomacy cases")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {(cases.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无外交问题", "No diplomacy cases")}</p> : (cases.data ?? []).map((item) => (
            <div key={item.id} className="rounded-md border border-border/50 p-4 space-y-3">
              <div className="flex flex-wrap justify-between gap-2"><div><div className="font-medium">{item.subject}</div><div className="text-xs text-muted-foreground">{item.counterparty} · {item.submitterName} · {new Date(item.createdAt).toLocaleString()}</div></div><div className="flex gap-2"><Badge variant={item.urgency === "urgent" ? "destructive" : "outline"}>{item.urgency}</Badge><Badge>{statusLabels[item.status] ?? item.status}</Badge></div></div>
              <p className="text-sm whitespace-pre-wrap">{item.description}</p>
              {item.evidenceUrl && <a className="text-sm text-primary hover:underline" href={item.evidenceUrl} target="_blank" rel="noreferrer">{tr("查看证据", "View evidence")}</a>}
              {canManage && <div className="space-y-2 border-t border-border/50 pt-3"><Textarea placeholder={tr("内部处理记录", "Internal notes")} value={notes[item.id] ?? item.internalNotes ?? ""} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} /><div className="flex flex-wrap gap-2">{["accepted", "investigating", "waiting", "resolved", "rejected", "closed"].map((status) => <Button key={status} size="sm" variant={status === "resolved" ? "default" : "outline"} onClick={() => update.mutate({ id: item.id, data: { status, internalNotes: notes[item.id] ?? item.internalNotes ?? "" } }, { onSuccess: refresh })}>{statusLabels[status]}</Button>)}</div></div>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
