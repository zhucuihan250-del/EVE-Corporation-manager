import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetActivityReport, useUpdateActivitySettings } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { Activity, CheckCircle2, Clock3, Save, TriangleAlert, Users } from "lucide-react";

function currentMonth(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

export function AdminActivity() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [month, setMonth] = useState(currentMonth());
  const [filter, setFilter] = useState<"all" | "below" | "met">("all");
  const [minimumPap, setMinimumPap] = useState("2");
  const report = useGetActivityReport({ month });
  const updateSettings = useUpdateActivitySettings();

  useEffect(() => {
    if (report.data) setMinimumPap(String(report.data.minimumPap));
  }, [report.data?.minimumPap]);

  const visibleMembers = useMemo(() => (report.data?.members ?? []).filter((member) => (
    filter === "all" || (filter === "met" ? member.metRequirement : !member.metRequirement)
  )), [filter, report.data?.members]);

  const saveSettings = () => {
    const value = Number(minimumPap);
    if (!Number.isFinite(value) || value < 0 || value > 1_000) {
      toast({ title: tr("PAP要求必须在0到1000之间", "PAP requirement must be between 0 and 1000"), variant: "destructive" });
      return;
    }
    updateSettings.mutate({ data: { minimumPap: value } }, {
      onSuccess: async () => {
        await queryClient.invalidateQueries({ queryKey: ["/api/activity"] });
        toast({ title: tr("每月PAP要求已更新", "Monthly PAP requirement updated") });
      },
      onError: (error) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider"><Activity className="h-6 w-6 text-primary" />{tr("活跃度查询", "ACTIVITY TRACKING")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{tr("自动纳入主角色已加入当前军团至少60天的玩家，并按月检查PAP是否达标。", "Automatically includes players whose main character has been in the corporation for at least 60 days and checks monthly PAP compliance.")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{tr("查询与标准", "Period and requirement")}</CardTitle>
          <CardDescription>{tr("入团门槛固定为60天；每月最低PAP可由管理人员调整。", "The eligibility threshold is fixed at 60 days; managers can adjust the monthly PAP minimum.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3 md:items-end">
          <div className="space-y-2"><Label>{tr("统计月份", "Month")}</Label><Input type="month" max={currentMonth()} value={month} onChange={(event) => setMonth(event.target.value)} /></div>
          <div className="space-y-2"><Label>{tr("每月最低PAP", "Minimum monthly PAP")}</Label><Input type="number" min="0" max="1000" step="0.5" value={minimumPap} onChange={(event) => setMinimumPap(event.target.value)} /></div>
          <Button onClick={saveSettings} disabled={updateSettings.isPending}><Save className="mr-2 h-4 w-4" />{tr("保存标准", "Save requirement")}</Button>
        </CardContent>
      </Card>

      {report.isError ? (
        <Card className="border-destructive/40"><CardContent className="p-5 text-sm text-destructive">{getErrorMessage(report.error)}</CardContent></Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><Users className="h-4 w-4" />{tr("纳入统计", "Eligible")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold">{report.data?.totalEligible ?? "-"}</CardContent></Card>
            <Card className="border-emerald-500/30"><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-400" />{tr("已达标", "Meeting requirement")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-emerald-400">{report.data?.meetingRequirement ?? "-"}</CardContent></Card>
            <Card className="border-amber-500/30"><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><TriangleAlert className="h-4 w-4 text-amber-400" />{tr("未达标", "Below requirement")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-amber-400">{report.data?.belowRequirement ?? "-"}</CardContent></Card>
          </div>

          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><CardTitle>{month} · {tr("成员明细", "Member details")}</CardTitle><CardDescription>{tr(`标准：入团满60天且当月至少 ${report.data?.minimumPap ?? minimumPap} PAP`, `Requirement: 60 days in corporation and at least ${report.data?.minimumPap ?? minimumPap} PAP in the month`)}</CardDescription></div>
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">{tr("全部", "All")}</option><option value="below">{tr("仅未达标", "Below only")}</option><option value="met">{tr("仅已达标", "Meeting only")}</option></select>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>{tr("主角色", "Main character")}</TableHead><TableHead>{tr("入团时间", "Joined")}</TableHead><TableHead>{tr("入团天数", "Days")}</TableHead><TableHead>{tr("当月PAP", "Monthly PAP")}</TableHead><TableHead>{tr("状态", "Status")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {visibleMembers.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="font-medium">{member.characterName}<div className="text-xs text-muted-foreground">{member.role}</div></TableCell>
                      <TableCell>{new Date(member.corporationJoinedAt).toLocaleDateString()}</TableCell>
                      <TableCell>{member.daysInCorporation}</TableCell>
                      <TableCell><span className="font-semibold">{member.pap}</span><span className="ml-1 text-xs text-muted-foreground">({member.papRecords} {tr("条记录", "records")})</span></TableCell>
                      <TableCell>{member.metRequirement ? <Badge className="bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />{tr("达标", "Met")}</Badge> : <Badge variant="destructive"><Clock3 className="mr-1 h-3 w-3" />{tr(`缺少 ${member.remainingPap} PAP`, `${member.remainingPap} PAP remaining`)}</Badge>}</TableCell>
                    </TableRow>
                  ))}
                  {!report.isLoading && visibleMembers.length === 0 && <TableRow><TableCell colSpan={5} className="py-10 text-center text-muted-foreground">{tr("当前条件下没有成员", "No members match the current filter")}</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
