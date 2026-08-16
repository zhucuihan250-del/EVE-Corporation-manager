import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useGetActivityReport, useGetRecentUnboundMembers, useUpdateActivitySettings } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { apiUrl } from "@/lib/api";
import { Activity, CalendarClock, CheckCircle2, Clock3, Link2, RefreshCw, Save, ShieldCheck, TriangleAlert, Users, UserX } from "lucide-react";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
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
  const rosterAudit = useGetRecentUnboundMembers();
  const updateSettings = useUpdateActivitySettings();

  useEffect(() => {
    if (report.data) setMinimumPap(String(report.data.configuredMinimumPap));
  }, [report.data?.configuredMinimumPap]);

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
        <p className="mt-1 text-sm text-muted-foreground">{tr("自动纳入主角色已加入当前军团至少60天的玩家，按月检查PAP并在月末自动结算最低PAP。", "Automatically includes players whose main character has been in the corporation for at least 60 days, checks monthly PAP, and settles the minimum PAP at month-end.")}</p>
      </div>

      <Card className="border-primary/30">
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2"><UserX className="h-5 w-5 text-primary" />{tr("近60天新成员未绑定审查", "RECENT UNBOUND MEMBER AUDIT")}</CardTitle>
            <CardDescription>{tr("对照当前军团的 EVE 完整成员名册，找出最近60天入团但尚未绑定 PAP 网站的角色。其他军团的数据不会出现在本军团结果中。", "Compares this corporation's complete EVE roster with PAP site bindings and finds characters who joined in the last 60 days without binding. Other corporations never appear in these results.")}</CardDescription>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href={apiUrl("/api/activity/new-members/connect")}><Link2 className="mr-2 h-4 w-4" />{rosterAudit.data?.connection ? tr("重新授权", "Reauthorize") : tr("总监授权名册", "Authorize roster")}</a>
            </Button>
            <Button variant="outline" onClick={() => rosterAudit.refetch()} disabled={rosterAudit.isFetching || !rosterAudit.data?.connection}>
              <RefreshCw className={`mr-2 h-4 w-4 ${rosterAudit.isFetching ? "animate-spin" : ""}`} />{tr("重新审查", "Review now")}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {rosterAudit.isLoading ? (
            <div className="py-6 text-center text-sm text-muted-foreground">{tr("正在读取军团成员名册…", "Loading corporation roster…")}</div>
          ) : rosterAudit.isError ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
              <div className="flex items-center gap-2 font-medium text-destructive"><TriangleAlert className="h-4 w-4" />{tr("名册审查失败", "Roster audit failed")}</div>
              <p className="mt-2 text-muted-foreground">{getErrorMessage(rosterAudit.error)}</p>
              <p className="mt-2 text-muted-foreground">{tr("请由当前军团中拥有 Director 角色的角色重新授权。", "Reauthorize with a character in this corporation who has the Director role.")}</p>
            </div>
          ) : !rosterAudit.data?.connection ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-4 text-sm">
              <div className="flex items-center gap-2 font-medium text-amber-400"><ShieldCheck className="h-4 w-4" />{tr("需要一次军团总监授权", "Director authorization required")}</div>
              <p className="mt-2 text-muted-foreground">{tr("网站数据库只包含已经绑定的人。请由拥有 EVE 军团 Director 角色的角色通过 SSO 授权成员追踪权限，授权仅用于本军团的新成员审查。", "The site database only contains already-bound users. A character with the EVE corporation Director role must authorize member tracking through SSO; the authorization is used only for this corporation's new-member audit.")}</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{tr("军团当前成员", "Current members")}</div><div className="mt-1 text-2xl font-bold">{rosterAudit.data.totalCorporationMembers ?? "-"}</div></div>
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{tr("近60天入团", "Joined in 60 days")}</div><div className="mt-1 text-2xl font-bold">{rosterAudit.data.recentMemberCount}</div></div>
                <div className="rounded-md border border-amber-500/30 p-3"><div className="text-xs text-muted-foreground">{tr("尚未绑定", "Not bound")}</div><div className="mt-1 text-2xl font-bold text-amber-400">{rosterAudit.data.unboundMemberCount}</div></div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{tr("名单按入团时间从新到旧排列。", "Members are ordered from newest to oldest join date.")}</span>
                {rosterAudit.data.reviewedAt && <span>{tr("审查时间", "Reviewed")}：{new Date(rosterAudit.data.reviewedAt).toLocaleString()}</span>}
              </div>
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead>{tr("角色", "Character")}</TableHead><TableHead>{tr("入团时间", "Joined")}</TableHead><TableHead>{tr("已入团", "Days in corporation")}</TableHead><TableHead>{tr("网站状态", "Site status")}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {rosterAudit.data.members.map((member) => (
                      <TableRow key={member.characterId}>
                        <TableCell className="font-medium">{member.characterName}<div className="text-xs text-muted-foreground">ID {member.characterId}</div></TableCell>
                        <TableCell>{new Date(member.corporationJoinedAt).toLocaleString()}</TableCell>
                        <TableCell>{tr(`${member.daysInCorporation} 天`, `${member.daysInCorporation} days`)}</TableCell>
                        <TableCell><Badge variant="destructive"><UserX className="mr-1 h-3 w-3" />{tr("未绑定", "Not bound")}</Badge></TableCell>
                      </TableRow>
                    ))}
                    {rosterAudit.data.members.length === 0 && <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground"><CheckCircle2 className="mx-auto mb-2 h-5 w-5 text-emerald-400" />{tr("近60天入团的成员均已绑定网站", "All members who joined in the last 60 days are bound to the site")}</TableCell></TableRow>}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{tr("查询与标准", "Period and requirement")}</CardTitle>
          <CardDescription>{tr("入团门槛固定为60天；每月最低PAP可由管理人员调整，并作为当月月末自动扣除数值。", "The eligibility threshold is fixed at 60 days; managers can adjust the monthly PAP minimum, which is automatically deducted at month-end.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-3 md:items-end">
          <div className="space-y-2"><Label>{tr("统计月份", "Month")}</Label><Input type="month" max={currentMonth()} value={month} onChange={(event) => setMonth(event.target.value)} /></div>
          <div className="space-y-2"><Label>{tr("每月最低PAP", "Minimum monthly PAP")}</Label><Input type="number" min="0" max="1000" step="0.5" value={minimumPap} onChange={(event) => setMinimumPap(event.target.value)} /></div>
          <Button onClick={saveSettings} disabled={updateSettings.isPending}><Save className="mr-2 h-4 w-4" />{tr("保存标准", "Save requirement")}</Button>
          <div className="rounded-md border border-primary/25 bg-primary/5 p-3 text-xs text-muted-foreground md:col-span-3">{tr("按 EVE 时间（UTC）结算：成员进入活跃度审查后，每个自然月结束会从其 PAP 余额扣除当月最低标准；余额不足时扣至 0，账本记录实际扣除量。扣除记录不会计入下一月活跃度，同一成员同一月份只会结算一次。", "Settled in EVE time (UTC): after a member enters activity review, the monthly minimum is deducted from the PAP balance at the end of each calendar month. If the balance is insufficient, it is reduced to zero and the ledger records the amount actually deducted. The deduction does not count toward next month's activity, and each member is settled only once per month.")}</div>
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

          {report.data && <Card className={report.data.settlement.status === "settled" ? "border-emerald-500/30" : report.data.settlement.status === "pending" ? "border-amber-500/30" : "border-primary/20"}>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><CalendarClock className="h-4 w-4" />{tr("月末自动PAP结算", "Automatic month-end PAP settlement")}</CardDescription></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {report.data.settlement.status === "settled" ? <><div className="font-medium text-emerald-400">{tr("该月份已完成自动结算", "Automatic settlement completed for this month")}</div><div className="text-muted-foreground">{tr(`共 ${report.data.settlement.eligibleMemberCount ?? 0} 名成员，扣除 ${report.data.settlement.totalDeductedPap ?? 0} PAP`, `${report.data.settlement.eligibleMemberCount ?? 0} members, ${report.data.settlement.totalDeductedPap ?? 0} PAP deducted`)}</div>{report.data.settlement.settledAt && <div className="text-xs text-muted-foreground">{tr("结算时间", "Settled")}: {new Date(report.data.settlement.settledAt).toLocaleString()}</div>}</>
                : report.data.settlement.status === "scheduled" ? <><div className="font-medium">{tr(`将在本月结束后按 ${report.data.minimumPap} PAP/人自动结算`, `Will settle automatically after month-end at ${report.data.minimumPap} PAP per member`)}</div><div className="text-muted-foreground">{tr("最终扣除名单以月末时已经入团满60天且仍在本军团的成员为准。", "The final deduction roster includes members who have reached 60 days and are still in the corporation at month-end.")}</div></>
                  : report.data.settlement.status === "pending" ? <><div className="font-medium text-amber-400">{tr("该月份已到结算时间，自动任务正在等待处理", "This month is due and awaiting automatic settlement")}</div><div className="text-muted-foreground">{tr("系统每15分钟检查一次，完成后本页面会显示扣除总数。", "The system checks every 15 minutes; this page will show the totals after completion.")}</div></>
                    : <div className="text-muted-foreground">{tr("该月份早于自动扣除功能启用时间，不会追溯扣除。", "This month predates automatic deductions and will not be charged retroactively.")}</div>}
            </CardContent>
          </Card>}

          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><CardTitle>{month} · {tr("成员明细", "Member details")}</CardTitle><CardDescription>{tr(`标准：入团满60天且当月至少 ${report.data?.minimumPap ?? minimumPap} PAP`, `Requirement: 60 days in corporation and at least ${report.data?.minimumPap ?? minimumPap} PAP in the month`)}</CardDescription></div>
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">{tr("全部", "All")}</option><option value="below">{tr("仅未达标", "Below only")}</option><option value="met">{tr("仅已达标", "Meeting only")}</option></select>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>{tr("主角色", "Main character")}</TableHead><TableHead>{tr("入团时间", "Joined")}</TableHead><TableHead>{tr("入团天数", "Days")}</TableHead><TableHead>{tr("当月PAP", "Monthly PAP")}</TableHead><TableHead>{tr("状态", "Status")}</TableHead><TableHead>{tr("月末扣除", "Month-end deduction")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {visibleMembers.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="font-medium">{member.characterName}<div className="text-xs text-muted-foreground">{member.role}</div></TableCell>
                      <TableCell>{new Date(member.corporationJoinedAt).toLocaleDateString()}</TableCell>
                      <TableCell>{member.daysInCorporation}</TableCell>
                      <TableCell><span className="font-semibold">{member.pap}</span><span className="ml-1 text-xs text-muted-foreground">({member.papRecords} {tr("条记录", "records")})</span></TableCell>
                      <TableCell>{member.metRequirement ? <Badge className="bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />{tr("达标", "Met")}</Badge> : <Badge variant="destructive"><Clock3 className="mr-1 h-3 w-3" />{tr(`缺少 ${member.remainingPap} PAP`, `${member.remainingPap} PAP remaining`)}</Badge>}</TableCell>
                      <TableCell>{member.settledDeductionPap === null ? <Badge variant="outline">{report.data?.settlement.status === "not_applicable" ? tr("不追溯", "Not applicable") : tr("待结算", "Scheduled")}</Badge> : member.settledDeductionPap > 0 ? <span className="font-semibold text-destructive">-{member.settledDeductionPap} PAP</span> : <span className="font-semibold">0 PAP</span>}</TableCell>
                    </TableRow>
                  ))}
                  {!report.isLoading && visibleMembers.length === 0 && <TableRow><TableCell colSpan={6} className="py-10 text-center text-muted-foreground">{tr("当前条件下没有成员", "No members match the current filter")}</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
