import { useMemo, useState } from "react";
import { useGetActivityReport, useGetRecentUnboundMembers } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getErrorMessage } from "@/lib/api-error";
import { apiUrl } from "@/lib/api";
import { Activity, CalendarClock, CheckCircle2, Link2, RefreshCw, ShieldCheck, TriangleAlert, Users, UserX } from "lucide-react";

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function AdminActivity() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const [month, setMonth] = useState(currentMonth());
  const [filter, setFilter] = useState<"all" | "below" | "met">("all");
  const report = useGetActivityReport({ month });
  const rosterAudit = useGetRecentUnboundMembers();

  const visibleMembers = useMemo(() => (report.data?.members ?? []).filter((member) => (
    filter === "all" || (filter === "met" ? member.metRequirement : !member.metRequirement)
  )), [filter, report.data?.members]);

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider"><Activity className="h-6 w-6 text-primary" />{tr("活跃度查询", "ACTIVITY TRACKING")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{tr("主角色入团满60天后，系统每月月末自动扣除2 PAP；扣除不足的成员会在此处警报。", "After 60 days in the corporation, members are automatically charged 2 PAP at each month-end; insufficient deductions are alerted here.")}</p>
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
          <CardTitle>{tr("查询月份与扣除规则", "Month and deduction rule")}</CardTitle>
          <CardDescription>{tr("入团门槛固定为60天，每月扣除数量固定为2 PAP。", "Eligibility is fixed at 60 days and the monthly deduction is fixed at 2 PAP.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 md:items-end">
          <div className="space-y-2"><Label>{tr("统计月份", "Month")}</Label><Input type="month" max={currentMonth()} value={month} onChange={(event) => setMonth(event.target.value)} /></div>
          <div className="rounded-md border border-primary/25 bg-primary/5 p-4"><div className="text-xs text-muted-foreground">{tr("每月固定扣除", "Fixed monthly deduction")}</div><div className="mt-1 text-2xl font-bold font-mono">2 PAP</div></div>
          <div className="rounded-md border border-primary/25 bg-primary/5 p-3 text-xs text-muted-foreground md:col-span-2">{tr("按 EVE 时间（UTC）结算。月末仅从可用 PAP 扣除，市场冻结 PAP 不会被占用。余额不足时会扣除当时可用数量，并在查询中警报缺少的 PAP；同一成员每月只结算一次。", "Settled in EVE time (UTC). Only available PAP is charged; PAP locked in the market is protected. If the balance is insufficient, the available amount is deducted and the exact PAP shortage is alerted here. Each member is settled only once per month.")}</div>
        </CardContent>
      </Card>

      {report.isError ? (
        <Card className="border-destructive/40"><CardContent className="p-5 text-sm text-destructive">{getErrorMessage(report.error)}</CardContent></Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><Users className="h-4 w-4" />{tr("纳入统计", "Eligible")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold">{report.data?.totalEligible ?? "-"}</CardContent></Card>
            <Card className="border-emerald-500/30"><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-400" />{tr("扣除正常", "Deduction ready")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-emerald-400">{report.data?.meetingRequirement ?? "-"}</CardContent></Card>
            <Card className="border-destructive/40"><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><TriangleAlert className="h-4 w-4 text-destructive" />{tr("PAP不足警报", "Insufficient PAP alerts")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-destructive">{report.data?.belowRequirement ?? "-"}</CardContent></Card>
          </div>

          {report.data && <Card className={report.data.settlement.status === "settled" ? report.data.belowRequirement > 0 ? "border-destructive/40" : "border-emerald-500/30" : report.data.settlement.status === "pending" ? "border-amber-500/30" : "border-primary/20"}>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><CalendarClock className="h-4 w-4" />{tr("月末自动PAP结算", "Automatic month-end PAP settlement")}</CardDescription></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {report.data.settlement.status === "settled" ? <><div className={report.data.belowRequirement > 0 ? "font-medium text-destructive" : "font-medium text-emerald-400"}>{report.data.belowRequirement > 0 ? tr(`结算完成，${report.data.belowRequirement} 名成员 PAP 不足`, `Settlement completed with ${report.data.belowRequirement} insufficient PAP alert(s)`) : tr("该月份已完成扣除，无警报", "Monthly deductions completed with no alerts")}</div><div className="text-muted-foreground">{tr(`共 ${report.data.settlement.eligibleMemberCount ?? 0} 名成员，实际扣除 ${report.data.settlement.totalDeductedPap ?? 0} PAP`, `${report.data.settlement.eligibleMemberCount ?? 0} members, ${report.data.settlement.totalDeductedPap ?? 0} PAP deducted`)}</div>{report.data.settlement.settledAt && <div className="text-xs text-muted-foreground">{tr("结算时间", "Settled")}: {new Date(report.data.settlement.settledAt).toLocaleString()}</div>}</>
                : report.data.settlement.status === "scheduled" ? <><div className="font-medium">{tr(`将在本月结束后按 ${report.data.minimumPap} PAP/人自动结算`, `Will settle automatically after month-end at ${report.data.minimumPap} PAP per member`)}</div><div className="text-muted-foreground">{tr("最终扣除名单以月末时已经入团满60天且仍在本军团的成员为准。", "The final deduction roster includes members who have reached 60 days and are still in the corporation at month-end.")}</div></>
                  : report.data.settlement.status === "pending" ? <><div className="font-medium text-amber-400">{tr("该月份已到结算时间，自动任务正在等待处理", "This month is due and awaiting automatic settlement")}</div><div className="text-muted-foreground">{tr("系统每15分钟检查一次，完成后本页面会显示扣除总数。", "The system checks every 15 minutes; this page will show the totals after completion.")}</div></>
                    : <div className="text-muted-foreground">{tr("该月份早于自动扣除功能启用时间，不会追溯扣除。", "This month predates automatic deductions and will not be charged retroactively.")}</div>}
            </CardContent>
          </Card>}

          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><CardTitle>{month} · {tr("成员扣除结果", "Member deduction results")}</CardTitle><CardDescription>{tr("不再按当月获得 PAP 判定活跃度，仅显示固定 2 PAP 扣除结果与余额不足警报。", "Monthly earned PAP is no longer used; this view shows only the fixed 2 PAP deduction result and shortage alerts.")}</CardDescription></div>
              <select className="h-10 rounded-md border border-input bg-background px-3 text-sm" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">{tr("全部", "All")}</option><option value="below">{tr("仅警报", "Alerts only")}</option><option value="met">{tr("仅正常", "Normal only")}</option></select>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>{tr("主角色", "Main character")}</TableHead><TableHead>{tr("入团时间", "Joined")}</TableHead><TableHead>{tr("入团天数", "Days")}</TableHead><TableHead>{tr("当前可用 PAP", "Current available PAP")}</TableHead><TableHead>{tr("扣除状态", "Deduction status")}</TableHead><TableHead>{tr("月末扣除", "Month-end deduction")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {visibleMembers.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="font-medium">{member.characterName}<div className="text-xs text-muted-foreground">{member.role}</div></TableCell>
                      <TableCell>{new Date(member.corporationJoinedAt).toLocaleDateString()}</TableCell>
                      <TableCell>{member.daysInCorporation}</TableCell>
                      <TableCell className="font-semibold font-mono">{member.currentAvailablePap} PAP</TableCell>
                      <TableCell>{member.deductionStatus === "not_applicable" ? <Badge variant="outline">{tr("不追溯", "Not applicable")}</Badge> : member.hasInsufficientPapAlert ? <Badge variant="destructive"><TriangleAlert className="mr-1 h-3 w-3" />{tr(`PAP 不足，缺少 ${member.deductionShortfallPap}`, `${member.deductionShortfallPap} PAP short`)}</Badge> : member.deductionStatus === "deducted" ? <Badge className="bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />{tr("已完整扣除", "Deducted in full")}</Badge> : <Badge variant="outline"><CheckCircle2 className="mr-1 h-3 w-3" />{tr("余额充足", "Balance ready")}</Badge>}</TableCell>
                      <TableCell>{member.settledDeductionPap === null ? <Badge variant="outline">{report.data?.settlement.status === "not_applicable" ? tr("不追溯", "Not applicable") : tr("待结算", "Scheduled")}</Badge> : <span className={member.hasInsufficientPapAlert ? "font-semibold text-destructive" : "font-semibold text-emerald-400"}>-{member.settledDeductionPap} / {member.requiredDeductionPap} PAP</span>}</TableCell>
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
