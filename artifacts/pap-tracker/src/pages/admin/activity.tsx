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
import { activityPresentationState, rosterDaysLabel, rosterHasCompletedReview, rosterJoinDateLabel } from "@/lib/activity-presentation";
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
    filter === "all" || (filter === "met" ? !member.hasInsufficientPapAlert : member.hasInsufficientPapAlert)
  )), [filter, report.data?.members]);

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider"><Activity className="h-6 w-6 text-primary" />{tr("活跃度查询", "ACTIVITY TRACKING")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{tr("主角色入团满60天后，系统每月月末自动扣除2 PAP；连续3个已完成结算月份不足才触发 PAP 警报。本军团所有未绑定网站的角色都会警报。", "After 60 days in the corporation, members are automatically charged 2 PAP at month-end. PAP alerts require three consecutive insufficient completed months. Every current corporation character without a site binding is alerted.")}</p>
      </div>

      <Card className="border-primary/30">
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2"><UserX className="h-5 w-5 text-primary" />{tr("全军团未绑定角色警报", "ALL UNBOUND CHARACTER ALERTS")}</CardTitle>
            <CardDescription>{tr("对照当前军团的 EVE 完整成员名册，找出所有尚未绑定 PAP 网站的角色，不再限制入团时间。入团日期未知也不会漏掉未绑定警报。", "Compares the complete current corporation EVE roster with PAP site bindings, regardless of join date. Unknown join dates never suppress an unbound character alert.")}</CardDescription>
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
              <p className="mt-2 text-muted-foreground">{tr("仅凭网站现有角色数据无法确认军团完整成员名单。请由拥有 EVE 军团 Director 角色的角色通过 SSO 授权成员追踪权限，用于审查本军团的完整名册。授权前无法判断是否存在未绑定角色。", "The existing site data cannot establish the complete current corporation roster. A character with the EVE corporation Director role must authorize member tracking through SSO to review the complete roster. Unbound characters cannot be determined before authorization.")}</p>
            </div>
          ) : (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{tr("军团当前成员", "Current members")}</div><div className="mt-1 text-2xl font-bold">{rosterAudit.data.totalCorporationMembers ?? "-"}</div></div>
                <div className="rounded-md border p-3"><div className="text-xs text-muted-foreground">{tr("已审查角色", "Characters reviewed")}</div><div className="mt-1 text-2xl font-bold">{rosterAudit.data.reviewedMemberCount}</div></div>
                <div className="rounded-md border border-destructive/40 p-3"><div className="text-xs text-muted-foreground">{tr("未绑定警报", "Unbound alerts")}</div><div className="mt-1 text-2xl font-bold text-destructive">{rosterHasCompletedReview(rosterAudit.data) ? rosterAudit.data.unboundMemberCount : "—"}</div></div>
              </div>
              {(!rosterHasCompletedReview(rosterAudit.data) || rosterAudit.data.unknownJoinDateCount > 0) && <div className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm text-amber-300">{!rosterHasCompletedReview(rosterAudit.data) ? tr("尚未取得有效的完整名册审查结果，不能据此确认没有未绑定角色。请重新审查或重新授权。", "No valid full-roster review is available. This does not confirm that every character is bound. Review again or reauthorize.") : tr(`名册中有 ${rosterAudit.data.unknownJoinDateCount} 个角色的入团时间未知；仍正常核对网站绑定状态。`, `${rosterAudit.data.unknownJoinDateCount} character(s) have an unknown join date; site bindings are still checked.`)}</div>}
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{tr("涵盖所有当前成员；已知入团日期从新到旧排列，日期未知者单独保留。", "All current members are covered. Known join dates are ordered newest first; unknown dates remain included.")}</span>
                {rosterAudit.data.reviewedAt && <span>{tr("审查时间", "Reviewed")}：{new Date(rosterAudit.data.reviewedAt).toLocaleString()}</span>}
              </div>
              <div className="overflow-hidden rounded-md border">
                <Table>
                  <TableHeader><TableRow><TableHead>{tr("角色", "Character")}</TableHead><TableHead>{tr("入团时间", "Joined")}</TableHead><TableHead>{tr("已入团", "Days in corporation")}</TableHead><TableHead>{tr("网站状态", "Site status")}</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {rosterAudit.data.members.map((member) => (
                      <TableRow key={member.characterId}>
                        <TableCell className="font-medium">{member.characterName}<div className="text-xs text-muted-foreground">ID {member.characterId}</div></TableCell>
                        <TableCell>{rosterJoinDateLabel(member.corporationJoinedAt, member.joinDateKnown, zh)}</TableCell>
                        <TableCell>{rosterDaysLabel(member.daysInCorporation, member.joinDateKnown, zh)}</TableCell>
                        <TableCell><Badge variant="destructive"><UserX className="mr-1 h-3 w-3" />{tr("未绑定", "Not bound")}</Badge></TableCell>
                      </TableRow>
                    ))}
                    {rosterAudit.data.members.length === 0 && <TableRow><TableCell colSpan={4} className="py-8 text-center text-muted-foreground">{rosterHasCompletedReview(rosterAudit.data) ? <><CheckCircle2 className="mx-auto mb-2 h-5 w-5 text-emerald-400" />{tr("本次完整名册审查未发现未绑定角色", "No unbound characters were found in this full-roster review")}</> : tr("尚无有效审查结果", "No valid review result is available")}</TableCell></TableRow>}
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
          <CardDescription>{tr("入团门槛固定为60天，每月扣除数量固定为2 PAP，PAP 警报门槛为连续3个已完成月份。", "Eligibility is fixed at 60 days, the monthly deduction at 2 PAP, and the PAP alert threshold at three consecutive completed months.")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2 md:items-end">
          <div className="space-y-2"><Label>{tr("统计月份", "Month")}</Label><Input type="month" max={currentMonth()} value={month} onChange={(event) => setMonth(event.target.value)} /></div>
          <div className="rounded-md border border-primary/25 bg-primary/5 p-4"><div className="text-xs text-muted-foreground">{tr("每月固定扣除", "Fixed monthly deduction")}</div><div className="mt-1 text-2xl font-bold font-mono">2 PAP</div></div>
          <div className="rounded-md border border-primary/25 bg-primary/5 p-3 text-xs text-muted-foreground md:col-span-2">{tr("按 EVE 时间（UTC）结算。月末仅从可用 PAP 扣除，市场冻结 PAP 不会被占用。余额不足时扣除当时可用数量，每月只结算一次。连续1或2个月不足仅记录观察；当月余额预测不触发警报，正常完成一个月扣除后连续不足记录重新计算。", "Settled in EVE time (UTC), once per member per month, using only available PAP; market-locked PAP is protected. One or two insufficient completed months are observations only. Current-month forecasts never trigger alerts. A full monthly deduction resets the insufficient-month streak.")}</div>
          <div className="rounded-md border p-3 text-xs text-muted-foreground md:col-span-2">{tr("已离开本军团的授权角色不参与 PAP 不足警报；确认离团后保留角色数据3个日历月，到期自动清理。", "Authorized characters who have left this corporation are excluded from PAP shortage alerts. Their character data is retained for three calendar months after departure is confirmed, then automatically removed.")}</div>
        </CardContent>
      </Card>

      {report.isError ? (
        <Card className="border-destructive/40"><CardContent className="p-5 text-sm text-destructive">{getErrorMessage(report.error)}</CardContent></Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><Users className="h-4 w-4" />{tr("纳入统计", "Eligible")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold">{report.data?.totalEligible ?? "-"}</CardContent></Card>
            <Card className="border-emerald-500/30"><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-emerald-400" />{tr("暂无 PAP 警报", "No PAP alert")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-emerald-400">{report.data?.meetingRequirement ?? "-"}</CardContent></Card>
            <Card className="border-destructive/40"><CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><TriangleAlert className="h-4 w-4 text-destructive" />{tr("连续3个月 PAP 不足警报", "Three-month PAP alerts")}</CardDescription></CardHeader><CardContent className="text-3xl font-bold text-destructive">{report.data?.belowRequirement ?? "-"}</CardContent></Card>
          </div>

          {report.data && <Card className={report.data.settlement.status === "settled" ? report.data.belowRequirement > 0 ? "border-destructive/40" : "border-emerald-500/30" : report.data.settlement.status === "pending" ? "border-amber-500/30" : "border-primary/20"}>
            <CardHeader className="pb-2"><CardDescription className="flex items-center gap-2"><CalendarClock className="h-4 w-4" />{tr("月末自动PAP结算", "Automatic month-end PAP settlement")}</CardDescription></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {report.data.settlement.status === "settled" ? <><div className={report.data.belowRequirement > 0 ? "font-medium text-destructive" : "font-medium text-emerald-400"}>{report.data.belowRequirement > 0 ? tr(`结算完成，${report.data.belowRequirement} 名成员连续3个月 PAP 不足`, `Settlement completed; ${report.data.belowRequirement} member(s) have a three-month PAP alert`) : tr("该月份已完成扣除，无连续3个月不足警报", "Monthly deductions completed with no three-month alerts")}</div><div className="text-muted-foreground">{tr(`共 ${report.data.settlement.eligibleMemberCount ?? 0} 名成员，实际扣除 ${report.data.settlement.totalDeductedPap ?? 0} PAP；该月不足 ${report.data.settlement.insufficientPapCount ?? 0} 人（不足不等于警报）。`, `${report.data.settlement.eligibleMemberCount ?? 0} members, ${report.data.settlement.totalDeductedPap ?? 0} PAP deducted; ${report.data.settlement.insufficientPapCount ?? 0} shortage(s) this month (a shortage alone is not an alert).`)}</div>{report.data.settlement.settledAt && <div className="text-xs text-muted-foreground">{tr("结算时间", "Settled")}: {new Date(report.data.settlement.settledAt).toLocaleString()}</div>}</>
                : report.data.settlement.status === "scheduled" ? <><div className="font-medium">{tr(`将在本月结束后按 ${report.data.minimumPap} PAP/人自动结算`, `Will settle automatically after month-end at ${report.data.minimumPap} PAP per member`)}</div><div className="text-muted-foreground">{tr("最终扣除名单以月末时已经入团满60天且仍在本军团的成员为准。", "The final deduction roster includes members who have reached 60 days and are still in the corporation at month-end.")}</div></>
                  : report.data.settlement.status === "pending" ? <><div className="font-medium text-amber-400">{tr("该月份已到结算时间，自动任务正在等待处理", "This month is due and awaiting automatic settlement")}</div><div className="text-muted-foreground">{tr("系统每15分钟检查一次，完成后本页面会显示扣除总数。", "The system checks every 15 minutes; this page will show the totals after completion.")}</div></>
                    : <div className="text-muted-foreground">{tr("该月份早于自动扣除功能启用时间，不会追溯扣除。", "This month predates automatic deductions and will not be charged retroactively.")}</div>}
            </CardContent>
          </Card>}

          <Card>
            <CardHeader className="gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div><CardTitle>{month} · {tr("成员扣除结果", "Member deduction results")}</CardTitle><CardDescription>{tr("固定 2 PAP 扣除结果与连续不足记录分开展示；仅达到连续3个已完成月份不足时警报。已离团角色不会出现在 PAP 警报名单中。", "Fixed 2 PAP deduction results and shortage streaks are separate. Only three consecutive insufficient completed months trigger an alert. Departed characters are excluded from PAP alerts.")}</CardDescription></div>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto" value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)}><option value="all">{tr("全部", "All")}</option><option value="below">{tr("仅警报", "Alerts only")}</option><option value="met">{tr("暂无警报（含观察）", "No alert (includes observations)")}</option></select>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader><TableRow><TableHead>{tr("主角色", "Main character")}</TableHead><TableHead>{tr("入团时间", "Joined")}</TableHead><TableHead>{tr("入团天数", "Days")}</TableHead><TableHead>{tr("当前可用 PAP", "Current available PAP")}</TableHead><TableHead>{tr("扣除状态", "Deduction status")}</TableHead><TableHead>{tr("连续不足月份", "Insufficient month streak")}</TableHead><TableHead>{tr("月末扣除", "Month-end deduction")}</TableHead></TableRow></TableHeader>
                <TableBody>
                  {visibleMembers.map((member) => (
                    <TableRow key={member.userId}>
                      <TableCell className="font-medium">{member.characterName}<div className="text-xs text-muted-foreground">{member.role}</div></TableCell>
                      <TableCell>{new Date(member.corporationJoinedAt).toLocaleDateString()}</TableCell>
                      <TableCell>{member.daysInCorporation}</TableCell>
                      <TableCell className="font-semibold font-mono">{member.currentAvailablePap} PAP</TableCell>
                      <TableCell>{activityPresentationState(member) === "not_applicable" ? <Badge variant="outline">{tr("不追溯", "Not applicable")}</Badge> : activityPresentationState(member) === "alert" ? <Badge variant="destructive"><TriangleAlert className="mr-1 h-3 w-3" />{tr(`连续 ${member.consecutiveInsufficientMonths} 个月不足`, `${member.consecutiveInsufficientMonths} insufficient months`)}</Badge> : activityPresentationState(member) === "observing" ? <Badge variant="outline" className="border-amber-500/40 text-amber-300">{tr(`扣除不足，观察中（缺 ${member.deductionShortfallPap}）`, `Shortage observed (${member.deductionShortfallPap} PAP short)`)}</Badge> : activityPresentationState(member) === "forecast_shortfall" ? <Badge variant="outline">{tr("预计余额不足（不警报）", "Forecast shortage (no alert)")}</Badge> : activityPresentationState(member) === "deducted" ? <Badge className="bg-emerald-600"><CheckCircle2 className="mr-1 h-3 w-3" />{tr("已完整扣除", "Deducted in full")}</Badge> : <Badge variant="outline">{tr("待结算", "Awaiting settlement")}</Badge>}</TableCell>
                      <TableCell><span className={member.hasInsufficientPapAlert ? "font-semibold text-destructive" : "font-mono"}>{member.consecutiveInsufficientMonths} / {report.data?.alertThresholdMonths ?? 3}</span><div className="text-xs text-muted-foreground">{member.alertAnchorMonth ? tr(`截至 ${member.alertAnchorMonth} 已完成月`, `Through completed month ${member.alertAnchorMonth}`) : tr("尚无已完成结算月", "No completed settlement month")}</div></TableCell>
                      <TableCell>{member.settledDeductionPap === null ? <Badge variant="outline">{report.data?.settlement.status === "not_applicable" ? tr("不追溯", "Not applicable") : tr("待结算", "Scheduled")}</Badge> : <span className={member.hasInsufficientPapAlert ? "font-semibold text-destructive" : member.selectedMonthHasShortfall ? "font-semibold text-amber-300" : "font-semibold text-emerald-400"}>-{member.settledDeductionPap} / {member.requiredDeductionPap} PAP</span>}</TableCell>
                    </TableRow>
                  ))}
                  {!report.isLoading && visibleMembers.length === 0 && <TableRow><TableCell colSpan={7} className="py-10 text-center text-muted-foreground">{tr("当前条件下没有成员", "No members match the current filter")}</TableCell></TableRow>}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
