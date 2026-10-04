import { useEffect, useState } from "react";
import { useGetMe } from "@workspace/api-client-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useSearch } from "wouter";
import {
  CheckCircle2,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Timer,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { apiUrl } from "@/lib/api";
import { formatPapDecimal } from "@/lib/pap-currency-presentation";
import {
  dutyPapApi,
  dutyPapKeys,
  formatDutyDuration,
  formatDutyUtc,
  dutyStatusLabel,
  dutyAuthorizationErrorLabel,
} from "@/lib/duty-pap-api";

export function DutyPap() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const { data: user } = useGetMe();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const search = useSearch();
  const mine = useQuery({
    queryKey: [...dutyPapKeys.mine, user?.id, user?.corporationId],
    queryFn: ({ signal }) => dutyPapApi.mine(signal),
    enabled: Boolean(user?.id && user.modules.pap && user.modules.fleet),
    refetchInterval: 60_000,
  });
  const [selectedCharacterId, setSelectedCharacterId] = useState("");
  const [pauseOpen, setPauseOpen] = useState(false);
  const connection = mine.data?.connection;
  useEffect(() => {
    if (!selectedCharacterId && mine.data)
      setSelectedCharacterId(
        String(connection?.characterId ?? mine.data.characters[0]?.id ?? ""),
      );
  }, [mine.data, connection?.characterId, selectedCharacterId]);
  useEffect(() => {
    setSelectedCharacterId("");
    setPauseOpen(false);
  }, [user?.id, user?.corporationId]);
  useEffect(() => {
    const params = new URLSearchParams(search);
    if (params.get("connected") === "1")
      toast({
        title: tr(
          "值守采集已授权并启用",
          "Duty collection authorized and enabled",
        ),
      });
    else if (params.get("error")?.startsWith("duty_"))
      toast({
        title: tr("值守授权未完成", "Duty authorization was not completed"),
        description: dutyAuthorizationErrorLabel(params.get("error") ?? "", zh),
        variant: "destructive",
      });
  }, [search]);
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: dutyPapKeys.all });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => {
      if (!connection)
        throw new Error(tr("请先授权角色", "Authorize a character first"));
      return dutyPapApi.connection({ version: connection.version, enabled });
    },
    onSuccess: async () => {
      setPauseOpen(false);
      await refresh();
      toast({ title: tr("采集设置已更新", "Collection settings updated") });
    },
    onError: async () => {
      await refresh();
    },
  });
  const selectedExists = Boolean(
    mine.data?.characters.some(
      (character) => String(character.id) === selectedCharacterId,
    ),
  );

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Timer className="h-6 w-6 text-primary" />
            {tr("值守 PAP", "Duty PAP")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              "加入军团认可的值守舰队，按已核验的有效时间自动发放 PAP。外部 FC 也可以带队。",
              "Join a corporation-recognized duty fleet to earn PAP from verified participation time. External FCs can lead the fleet.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={mine.isFetching || toggle.isPending}
          onClick={() => void refresh()}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${mine.isFetching ? "animate-spin" : ""}`}
          />
          {tr("刷新", "Refresh")}
        </Button>
      </div>
      {mine.isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      )}
      {(mine.error || toggle.error) && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          {getErrorMessage(toggle.error ?? mine.error)}
        </div>
      )}
      {mine.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4 text-primary" />
                {tr("我的采集授权", "My collection authorization")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "只读取你选定角色的舰队、在线状态、位置和船型。关闭页面不会停止后台采集；可随时在这里暂停。",
                  "Read only your selected character's fleet, online state, location and ship type. Closing this page does not stop background collection; you can pause it here anytime.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground">
                    {tr("当前跟踪角色", "Tracked character")}
                  </p>
                  <p className="mt-1 font-medium">
                    {connection?.characterName ??
                      tr("尚未授权", "Not authorized")}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {tr("采集状态", "Collection status")}
                  </p>
                  <Badge
                    variant={
                      connection?.enabled && connection.hasRequiredScopes
                        ? "default"
                        : "secondary"
                    }
                    className="mt-1 whitespace-normal"
                  >
                    {dutyStatusLabel(
                      connection?.enabled
                        ? connection.status
                        : connection
                          ? "paused"
                          : "not_authorized",
                      zh,
                    )}
                  </Badge>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {tr("最后检查", "Last check")}
                  </p>
                  <p className="mt-1 break-words text-sm">
                    {formatDutyUtc(connection?.lastCheckedAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">
                    {tr("今日统计日期", "Today's reporting date")}
                  </p>
                  <p className="mt-1 text-sm">
                    {mine.data.day} UTC ·{" "}
                    {tr("约每 60 秒核验一次", "Checked about every 60 seconds")}
                  </p>
                </div>
              </div>
              {connection && !connection.hasRequiredScopes && (
                <p className="text-sm text-amber-400">
                  {tr(
                    "值守授权不足或已失效，需重新授权。失败间隔不发 PAP。",
                    "Duty authorization is missing or expired. Reauthorize; failed intervals do not earn PAP.",
                  )}
                </p>
              )}
              <div className="flex flex-wrap gap-2">
                {connection?.enabled ? (
                  <Button
                    variant="outline"
                    disabled={toggle.isPending}
                    onClick={() => {
                      toggle.reset();
                      setPauseOpen(true);
                    }}
                  >
                    <Pause className="mr-2 h-4 w-4" />
                    {tr("暂停采集", "Pause collection")}
                  </Button>
                ) : (
                  connection && (
                    <Button
                      disabled={
                        toggle.isPending || !connection.hasRequiredScopes
                      }
                      onClick={() => toggle.mutate(true)}
                    >
                      {toggle.isPending ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="mr-2 h-4 w-4" />
                      )}
                      {tr("启用采集", "Enable collection")}
                    </Button>
                  )
                )}
              </div>
              <div className="space-y-3 border-t pt-4">
                <Label htmlFor="duty-character">
                  {tr(
                    "选择需要授权的已绑定角色",
                    "Choose a linked character to authorize",
                  )}
                </Label>
                <div className="flex flex-col gap-3 sm:flex-row">
                  <Select
                    value={selectedCharacterId}
                    onValueChange={setSelectedCharacterId}
                    disabled={toggle.isPending || !mine.data.characters.length}
                  >
                    <SelectTrigger id="duty-character" className="sm:max-w-sm">
                      <SelectValue
                        placeholder={tr("选择角色", "Choose character")}
                      />
                    </SelectTrigger>
                    <SelectContent>
                      {mine.data.characters.map((character) => (
                        <SelectItem
                          key={character.id}
                          value={String(character.id)}
                        >
                          {character.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    disabled={!selectedExists || toggle.isPending}
                    onClick={() => {
                      if (selectedExists)
                        window.location.href = apiUrl(
                          `/api/auth/eve/duty?${new URLSearchParams({ characterId: selectedCharacterId })}`,
                        );
                    }}
                  >
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                    {connection?.characterId === Number(selectedCharacterId)
                      ? tr(
                          "重新授权并启用采集",
                          "Reauthorize and enable collection",
                        )
                      : tr("授权并启用采集", "Authorize and enable collection")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "点击授权即同意该角色的后台值守核验。切换角色会停止原角色计时并清除未结算余时，已经发放的 PAP 不受影响。请在 EVE 授权页登录同一角色。",
                    "Authorizing opts this character into background duty checks. Switching stops the previous character and clears incomplete time; existing PAP awards remain. Sign in as the same character on the EVE authorization page.",
                  )}
                </p>
                {!mine.data.characters.length && (
                  <Link
                    href="/characters"
                    className="text-sm text-primary hover:underline"
                  >
                    {tr("先绑定军团角色", "Link a corporation character first")}
                  </Link>
                )}
              </div>
            </CardContent>
          </Card>
          <section
            aria-label={tr("当前值守规则", "Current duty rules")}
            className="space-y-3"
          >
            <h2 className="text-lg font-semibold">
              {tr("当前规则与我的进度", "Current rules and my progress")}
            </h2>
            {!mine.data.rules.length ? (
              <Card>
                <CardContent className="py-8 text-center text-muted-foreground">
                  {tr(
                    "管理员尚未创建值守规则。授权不会自动创建或启用发放规则。",
                    "No duty rules have been created. Authorization does not create or enable award rules.",
                  )}
                </CardContent>
              </Card>
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                {mine.data.rules.map((rule) => {
                  const today = rule.today ?? {
                    eligibleSeconds: 0,
                    totalEligibleSeconds: 0,
                    awardCount: 0,
                    paidAmount: "0",
                  };
                  const percent = Math.min(
                    100,
                    (today.eligibleSeconds / (rule.minutesPerAward * 60)) * 100,
                  );
                  return (
                    <Card key={rule.id}>
                      <CardHeader>
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <CardTitle className="break-words text-base">
                            {rule.name}
                          </CardTitle>
                          <Badge
                            variant={rule.enabled ? "default" : "secondary"}
                          >
                            {rule.enabled
                              ? tr("已启用", "Enabled")
                              : tr("已停用", "Disabled")}
                          </Badge>
                        </div>
                        <CardDescription>
                          {tr("游戏舰队编号", "In-game fleet ID")}:{" "}
                          {rule.eveFleetId}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-4">
                        <p className="text-sm">
                          {tr("每", "Every")} {rule.minutesPerAward}{" "}
                          {tr("分钟有效值守", "minutes of verified duty")} →{" "}
                          {formatPapDecimal(rule.awardAmount)}{" "}
                          {rule.currencyName}
                        </p>
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          {[
                            [
                              tr("今日有效时长", "Verified time today"),
                              formatDutyDuration(
                                today.totalEligibleSeconds,
                                zh,
                              ),
                            ],
                            [
                              tr("本轮进度", "Current interval"),
                              formatDutyDuration(today.eligibleSeconds, zh),
                            ],
                            [
                              tr("今日已发", "Awarded today"),
                              `${formatPapDecimal(today.paidAmount)} ${rule.currencyName}`,
                            ],
                            [
                              tr("每日金额上限", "Daily amount limit"),
                              `${formatPapDecimal(rule.dailyCap)} ${rule.currencyName}`,
                            ],
                          ].map(([label, value]) => (
                            <div className="min-w-0" key={label}>
                              <div className="text-xs text-muted-foreground">
                                {label}
                              </div>
                              <div className="mt-1 break-words font-medium">
                                {value}
                              </div>
                            </div>
                          ))}
                        </div>
                        <div
                          role="progressbar"
                          aria-label={tr(
                            "本轮值守进度",
                            "Current duty interval progress",
                          )}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.floor(percent)}
                          className="h-2 overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className="h-full bg-primary"
                            style={{ width: `${percent}%` }}
                          />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {rule.requireUndocked
                            ? tr(
                                "必须在线且未停靠。",
                                "Must be online and undocked.",
                              )
                            : tr(
                                "必须在线；允许停靠。",
                                "Must be online; docking allowed.",
                              )}{" "}
                          {tr("星系限制", "System filter")}:{" "}
                          {rule.solarSystemIds.length || tr("不限", "None")} ·{" "}
                          {tr("舰种限制", "Ship filter")}:{" "}
                          {rule.shipTypeIds.length || tr("不限", "None")}
                        </p>
                        {!!rule.solarSystems?.length && (
                          <p className="break-words text-xs text-muted-foreground">
                            {tr("允许星系", "Allowed systems")}:{" "}
                            {rule.solarSystems
                              .map((system) => system.name)
                              .join(" · ")}
                          </p>
                        )}
                        {!!rule.shipTypes?.length && (
                          <p className="break-words text-xs text-muted-foreground">
                            {tr("允许舰船", "Allowed hulls")}:{" "}
                            {rule.shipTypes
                              .map((ship) => ship.name)
                              .join(" · ")}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {tr(
                            "达到今日上限后不再发放；最后一笔可能仅发放剩余额度。",
                            "Awards stop at the daily limit; the final award may be only the remaining amount.",
                          )}
                        </p>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </section>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tr("我的值守发放历史", "My duty award history")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "仅显示本人最近的值守记录；完整入账可在 PAP 钱包与历史中核对。",
                  "Shows only your recent duty awards. Verify complete credits in your PAP wallet and history.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {!mine.data.awards.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {tr("暂无值守发放记录", "No duty awards yet")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tr("时间", "Time")}</TableHead>
                      <TableHead>
                        {tr("规则／角色", "Rule / character")}
                      </TableHead>
                      <TableHead className="text-right">
                        {tr("已入账", "Credited")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {mine.data.awards.map((award) => (
                      <TableRow key={award.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDutyUtc(award.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{award.ruleName}</div>
                          <div className="text-xs text-muted-foreground">
                            {award.characterName}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="font-medium text-primary">
                            +{formatPapDecimal(award.amount)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {award.currencyName}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {tr("计时与发放规则", "Collection and award rules")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            {tr(
              "同一账号只跟踪一个角色，多个角色或多个规则的重叠值守不会重复计时。",
              "Only one character per account is tracked. Overlapping characters or rules do not earn duplicate time.",
            )}
          </p>
          <p>
            {tr(
              "按 UTC 日期计算每日上限；每日 00:00 UTC 重置未达一轮的进度。达到一轮要求后自动入账到对应 PAP 钱包。",
              "Daily limits use UTC dates. Incomplete progress resets at 00:00 UTC. Each completed interval is credited automatically to the relevant PAP wallet.",
            )}
          </p>
          <p>
            {tr(
              "接口故障、离线、停靠或不满足规则的间隔不计时，也不会自动回补。网站不能证明玩家正在看屏幕或听指挥。",
              "API failures, offline time, docking and unmet conditions do not count and are not automatically backfilled. The website cannot prove that a player is watching the screen or following commands.",
            )}
          </p>
          <Link
            href="/pap-wallet"
            className="inline-block text-primary hover:underline"
          >
            {tr("查看 PAP 钱包", "View PAP wallet")}
          </Link>
        </CardContent>
      </Card>
      <AlertDialog open={pauseOpen} onOpenChange={setPauseOpen}>
        <AlertDialogContent
          style={{
            width: "calc(100vw - 2rem)",
            maxWidth: 512,
            maxHeight: "calc(100dvh - 2rem)",
            overflowY: "auto",
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tr("暂停值守采集？", "Pause duty collection?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tr(
                "暂停会清除未结算的本轮余时，已经发放的 PAP 不变。重新启用后从新的核验开始计时。",
                "Pausing clears incomplete interval time but keeps all awarded PAP. Resuming starts from a new verified observation.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={toggle.isPending}>
              {tr("取消", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={toggle.isPending}
              onClick={(event) => {
                event.preventDefault();
                toggle.mutate(false);
              }}
            >
              {toggle.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {tr("确认暂停", "Confirm pause")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
