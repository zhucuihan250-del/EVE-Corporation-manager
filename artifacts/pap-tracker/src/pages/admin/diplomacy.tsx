import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListDiplomacyCases,
  useUpdateDiplomacyCase,
  type DiplomacyCase,
  type UpdateDiplomacyCaseBody,
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
import { CheckCircle2, ClipboardCheck, Clock3, MessageSquareText, Search, UserRoundCheck } from "lucide-react";

type Draft = { status: DiplomacyCase["status"]; publicReply: string; internalNotes: string };

export function AdminDiplomacy() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const cases = useListDiplomacyCases();
  const update = useUpdateDiplomacyCase();
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [urgencyFilter, setUrgencyFilter] = useState("all");
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const statusLabels: Record<string, string> = {
    submitted: tr("待受理", "Submitted"), accepted: tr("已受理", "Accepted"), investigating: tr("调查中", "Investigating"),
    waiting: tr("等待回复", "Waiting"), resolved: tr("已解决", "Resolved"), rejected: tr("已驳回", "Rejected"), closed: tr("已关闭", "Closed"),
  };
  const categoryLabels: Record<string, string> = {
    standings: tr("关系与声望", "Standings"), conflict: tr("冲突事件", "Conflict"), cooperation: tr("合作", "Cooperation"),
    compensation: tr("赔偿", "Compensation"), complaint: tr("投诉", "Complaint"), other: tr("其他", "Other"),
  };
  const urgencyLabels: Record<string, string> = { normal: tr("普通", "Normal"), high: tr("较高", "High"), urgent: tr("紧急", "Urgent") };
  const allCases = cases.data ?? [];
  const filtered = useMemo(() => allCases.filter((item) => {
    const needle = search.trim().toLocaleLowerCase();
    const matchesSearch = !needle || [item.subject, item.counterparty, item.submitterName, item.description].some((value) => value.toLocaleLowerCase().includes(needle));
    const matchesStatus = statusFilter === "all" || (statusFilter === "open" && !["resolved", "rejected", "closed"].includes(item.status)) || item.status === statusFilter;
    return matchesSearch && matchesStatus && (urgencyFilter === "all" || item.urgency === urgencyFilter);
  }), [allCases, search, statusFilter, urgencyFilter]);

  useEffect(() => {
    if (selectedId !== null && filtered.some((item) => item.id === selectedId)) return;
    setSelectedId(filtered[0]?.id ?? null);
  }, [filtered, selectedId]);

  const selected = allCases.find((item) => item.id === selectedId) ?? null;
  const draft = selected ? drafts[selected.id] ?? { status: selected.status, publicReply: selected.publicReply ?? "", internalNotes: selected.internalNotes ?? "" } : null;
  const setDraft = (patch: Partial<Draft>) => {
    if (!selected || !draft) return;
    setDrafts((current) => ({ ...current, [selected.id]: { ...draft, ...patch } }));
  };
  const mutate = (data: UpdateDiplomacyCaseBody, successMessage: string) => {
    if (!selected) return;
    update.mutate({ id: selected.id, data }, {
      onSuccess: async (item) => {
        setDrafts((current) => ({ ...current, [item.id]: { status: item.status, publicReply: item.publicReply ?? "", internalNotes: item.internalNotes ?? "" } }));
        await queryClient.invalidateQueries({ queryKey: ["/api/diplomacy"] });
        toast({ title: successMessage });
      },
      onError: (error) => toast({ title: tr("更新失败", "Update failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };
  const eventText = (event: DiplomacyCase["events"][number]) => {
    if (event.eventType === "submitted") return tr("提交了外交问题", "Submitted the diplomacy case");
    if (event.eventType === "status_changed") return tr(`状态从“${statusLabels[event.fromStatus ?? ""] ?? event.fromStatus}”更新为“${statusLabels[event.toStatus ?? ""] ?? event.toStatus}”`, `Status changed from ${statusLabels[event.fromStatus ?? ""] ?? event.fromStatus} to ${statusLabels[event.toStatus ?? ""] ?? event.toStatus}`);
    return event.message ?? event.eventType;
  };
  const summaryCards = [
    { label: tr("待受理", "Unassigned"), value: allCases.filter((item) => item.status === "submitted").length, icon: ClipboardCheck },
    { label: tr("处理中", "In progress"), value: allCases.filter((item) => ["accepted", "investigating"].includes(item.status)).length, icon: UserRoundCheck },
    { label: tr("等待回复", "Waiting"), value: allCases.filter((item) => item.status === "waiting").length, icon: Clock3 },
    { label: tr("已办结", "Finished"), value: allCases.filter((item) => ["resolved", "rejected", "closed"].includes(item.status)).length, icon: CheckCircle2 },
  ];

  return <div className="p-6 space-y-6">
    <div><h1 className="text-2xl font-bold font-mono tracking-wider">{tr("外交管理", "DIPLOMACY MANAGEMENT")}</h1><p className="mt-1 text-sm text-muted-foreground">{tr("受理本军团外交问题，记录对外回复和内部处理过程。", "Process this corporation's diplomacy cases and preserve official and internal handling records.")}</p></div>
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{summaryCards.map(({ label, value, icon: Icon }) => <Card key={label}><CardContent className="flex items-center justify-between p-4"><div><div className="text-xs text-muted-foreground">{label}</div><div className="text-2xl font-semibold">{value}</div></div><Icon className="h-5 w-5 text-primary" /></CardContent></Card>)}</div>
    <Card><CardContent className="grid gap-3 p-4 md:grid-cols-[1fr_180px_150px]"><div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input className="pl-9" placeholder={tr("搜索主题、对方或提交人", "Search subject, counterparty, or submitter")} value={search} onChange={(event) => setSearch(event.target.value)} /></div><select className="h-10 rounded-md border border-input bg-background px-3" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="open">{tr("未办结", "Open cases")}</option><option value="all">{tr("全部状态", "All statuses")}</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><select className="h-10 rounded-md border border-input bg-background px-3" value={urgencyFilter} onChange={(event) => setUrgencyFilter(event.target.value)}><option value="all">{tr("全部紧急程度", "All urgency")}</option>{Object.entries(urgencyLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></CardContent></Card>
    <div className="grid gap-5 lg:grid-cols-[340px_minmax(0,1fr)]">
      <Card className="h-fit"><CardHeader><CardTitle className="text-base">{tr("外交问题", "Cases")}</CardTitle><CardDescription>{tr(`共 ${filtered.length} 条`, `${filtered.length} case(s)`)}</CardDescription></CardHeader><CardContent className="space-y-2">{filtered.length === 0 ? <div className="py-8 text-center text-sm text-muted-foreground">{tr("没有符合条件的问题", "No matching cases")}</div> : filtered.map((item) => <button key={item.id} type="button" onClick={() => setSelectedId(item.id)} className={`w-full rounded-md border p-3 text-left transition-colors ${selectedId === item.id ? "border-primary bg-primary/10" : "border-border/50 hover:bg-muted/40"}`}><div className="flex items-start justify-between gap-2"><div className="line-clamp-2 text-sm font-medium">#{item.id} · {item.subject}</div><Badge variant={item.urgency === "urgent" ? "destructive" : "outline"} className="shrink-0">{urgencyLabels[item.urgency]}</Badge></div><div className="mt-2 text-xs text-muted-foreground">{item.counterparty} · {item.submitterName}</div><div className="mt-2 flex items-center justify-between gap-2"><Badge variant="secondary">{statusLabels[item.status]}</Badge><span className="text-[11px] text-muted-foreground">{new Date(item.updatedAt).toLocaleString(zh ? "zh-CN" : undefined)}</span></div></button>)}</CardContent></Card>
      {!selected || !draft ? <Card><CardContent className="py-20 text-center text-sm text-muted-foreground">{tr("请选择一条外交问题", "Select a diplomacy case")}</CardContent></Card> : <div className="space-y-5">
        <Card><CardHeader><div className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle>#{selected.id} · {selected.subject}</CardTitle><CardDescription className="mt-1">{categoryLabels[selected.category]} · {selected.counterparty}</CardDescription></div><div className="flex gap-2"><Badge variant={selected.urgency === "urgent" ? "destructive" : "outline"}>{urgencyLabels[selected.urgency]}</Badge><Badge>{statusLabels[selected.status]}</Badge></div></div></CardHeader><CardContent className="space-y-4"><div className="grid gap-3 sm:grid-cols-2"><Info label={tr("提交人", "Submitter")} value={selected.submitterName} /><Info label={tr("提交时间", "Submitted")} value={new Date(selected.createdAt).toLocaleString(zh ? "zh-CN" : undefined)} /></div><div><div className="mb-1 text-xs text-muted-foreground">{tr("详细经过", "Details")}</div><p className="whitespace-pre-wrap text-sm leading-6">{selected.description}</p></div>{selected.evidenceUrl && <a className="inline-block text-sm text-primary hover:underline" href={selected.evidenceUrl} target="_blank" rel="noreferrer">{tr("查看证据链接", "Open evidence")}</a>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><UserRoundCheck className="h-5 w-5 text-primary" />{tr("受理与状态", "Ownership and status")}</CardTitle><CardDescription>{selected.assignedName ? tr(`当前负责人：${selected.assignedName}`, `Current owner: ${selected.assignedName}`) : tr("当前尚无负责人", "No owner assigned")}</CardDescription></CardHeader><CardContent className="grid gap-3 sm:grid-cols-[1fr_auto_auto]"><select className="h-10 rounded-md border border-input bg-background px-3" value={draft.status} onChange={(event) => setDraft({ status: event.target.value as Draft["status"] })}>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><Button variant="outline" disabled={update.isPending} onClick={() => mutate({ assignment: "self" }, tr("已由你受理", "Case assigned to you"))}>{tr("由我受理", "Assign to me")}</Button><Button variant="ghost" disabled={update.isPending || !selected.assignedTo} onClick={() => mutate({ assignment: "unassigned" }, tr("已取消负责人", "Owner removed"))}>{tr("取消负责人", "Unassign")}</Button></CardContent></Card>
        <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><MessageSquareText className="h-5 w-5 text-primary" />{tr("处理内容", "Handling")}</CardTitle><CardDescription>{tr("对外回复会显示给提交人；内部记录仅外交管理人员可见。", "Official responses are visible to the submitter; internal notes remain manager-only.")}</CardDescription></CardHeader><CardContent className="space-y-4"><div className="space-y-2"><Label>{tr("对外处理回复", "Official response")}</Label><Textarea rows={5} value={draft.publicReply} onChange={(event) => setDraft({ publicReply: event.target.value })} /></div><div className="space-y-2"><Label>{tr("内部处理记录", "Internal notes")}</Label><Textarea rows={5} value={draft.internalNotes} onChange={(event) => setDraft({ internalNotes: event.target.value })} /></div><Button disabled={update.isPending} onClick={() => mutate({ status: draft.status, publicReply: draft.publicReply, internalNotes: draft.internalNotes }, tr("外交问题已更新", "Diplomacy case updated"))}>{tr("保存处理结果", "Save handling result")}</Button></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">{tr("完整处理记录", "Complete timeline")}</CardTitle></CardHeader><CardContent className="space-y-3">{selected.events.map((event) => <div key={`${event.id}-${event.createdAt}`} className="flex gap-3"><div className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${event.visibility === "internal" ? "bg-amber-400" : "bg-primary"}`} /><div><div className="text-sm">{eventText(event)} {event.visibility === "internal" && <Badge variant="outline" className="ml-2">{tr("内部", "Internal")}</Badge>}</div><div className="mt-0.5 text-xs text-muted-foreground">{event.actorName} · {new Date(event.createdAt).toLocaleString(zh ? "zh-CN" : undefined)}</div></div></div>)}</CardContent></Card>
      </div>}
    </div>
  </div>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="rounded-md bg-muted/30 p-3"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 text-sm font-medium">{value}</div></div>;
}
