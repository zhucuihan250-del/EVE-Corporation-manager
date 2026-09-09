import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetSystemMonitoringDashboardQueryKey,
  useCreateManualIntelReport,
  useGetSystemMonitoringDashboard,
  type SystemIntelEvent,
  type SystemMonitorSummary,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { SystemIntelMap } from "@/components/system-intel-map";
import { useTranslation } from "react-i18next";
import {
  Activity,
  CircleAlert,
  Clock3,
  ExternalLink,
  MapPin,
  Orbit,
  Radio,
  Send,
  ShieldCheck,
  Siren,
  Users,
} from "lucide-react";

const SHIP_TAGS = [
  "旗舰",
  "黑隐",
  "泡泡船",
  "战列舰",
  "战巡",
  "巡洋舰",
  "后勤",
  "隐轰",
  "工业舰",
];

const RISK_STYLE: Record<string, string> = {
  safe: "border-emerald-500/40 bg-emerald-500/10 text-emerald-300",
  info: "border-sky-500/40 bg-sky-500/10 text-sky-300",
  warning: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  danger: "border-orange-500/50 bg-orange-500/10 text-orange-300",
  critical: "border-rose-500/60 bg-rose-500/10 text-rose-300",
};

function riskLabel(risk: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    safe: ["安全", "SAFE"],
    info: ["有活动", "ACTIVITY"],
    warning: ["注意", "CAUTION"],
    danger: ["危险", "DANGER"],
    critical: ["严重", "CRITICAL"],
  };
  return labels[risk]?.[zh ? 0 : 1] ?? risk;
}

function sourceLabel(source: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    chat: ["预警频道", "INTEL CHANNEL"],
    manual: ["成员报告", "MEMBER REPORT"],
    killmail: ["击杀确认", "KILLMAIL"],
    activity: ["活动趋势", "ACTIVITY TREND"],
  };
  return labels[source]?.[zh ? 0 : 1] ?? source;
}

function confidenceLabel(confidence: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    unconfirmed: ["待确认", "UNCONFIRMED"],
    reported: ["实名报告", "NAMED REPORT"],
    confirmed: ["已确认", "CONFIRMED"],
  };
  return labels[confidence]?.[zh ? 0 : 1] ?? confidence;
}

function eventPopulation(event: SystemIntelEvent): {
  count: number;
  isParticipantCount: boolean;
} | null {
  const isParticipantCount =
    event.source === "killmail" || event.eventType === "kill_burst";
  const metadataCount = event.metadata.playerParticipantCount;
  const participantCount =
    typeof metadataCount === "number" && Number.isFinite(metadataCount)
      ? metadataCount
      : null;
  const count = isParticipantCount
    ? (participantCount ?? event.enemyCount)
    : event.enemyCount;
  return count === null
    ? null
    : { count: Math.max(0, count), isParticipantCount };
}

export function SystemMonitoring() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const dashboard = useGetSystemMonitoringDashboard({
    query: {
      queryKey: getGetSystemMonitoringDashboardQueryKey(),
      refetchInterval: 15_000,
    },
  });
  const createReport = useCreateManualIntelReport();
  const [monitorId, setMonitorId] = useState("");
  const [enemyCount, setEnemyCount] = useState("");
  const [direction, setDirection] = useState("");
  const [message, setMessage] = useState("");
  const [shipTags, setShipTags] = useState<string[]>([]);

  const activeEvents = useMemo(() => {
    const now = Date.now();
    return (dashboard.data?.events ?? []).filter(
      (event) => !event.expiresAt || new Date(event.expiresAt).getTime() > now,
    );
  }, [dashboard.data?.events]);

  const submit = () => {
    if (!monitorId || !message.trim()) return;
    createReport.mutate(
      {
        data: {
          monitorId: Number(monitorId),
          enemyCount: enemyCount ? Number(enemyCount) : null,
          shipTags,
          direction: direction.trim() || null,
          message: message.trim(),
        },
      },
      {
        onSuccess: async () => {
          setEnemyCount("");
          setDirection("");
          setMessage("");
          setShipTags([]);
          await queryClient.invalidateQueries({
            queryKey: getGetSystemMonitoringDashboardQueryKey(),
          });
          toast({
            title: tr("敌情已实名提交", "Named intelligence submitted"),
          });
        },
        onError: (error) =>
          toast({
            title: tr("提交失败", "Submission failed"),
            description: getErrorMessage(error),
            variant: "destructive",
          }),
      },
    );
  };

  if (dashboard.isLoading) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {tr("正在同步星系情报…", "Synchronizing system intelligence…")}
      </div>
    );
  }
  if (dashboard.isError) {
    return (
      <div className="p-6 text-sm text-destructive">
        {getErrorMessage(dashboard.error)}
      </div>
    );
  }

  const data = dashboard.data;
  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider">
            <Radio className="h-6 w-6 text-primary" />
            {tr("星系监控", "SYSTEM MONITORING")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tr(
              "融合预警频道、公开击杀报告和ESI活动趋势；没有报告不代表绝对安全。",
              "Combines intel-channel reports, public killmails, and ESI activity trends; no report does not guarantee safety.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              data?.bridgeStatus.online ? RISK_STYLE.safe : RISK_STYLE.warning
            }
          >
            <Radio className="mr-1.5 h-3 w-3" />
            {data?.bridgeStatus.online ?? 0}/{data?.bridgeStatus.total ?? 0}{" "}
            {tr("桥接在线", "bridges online")}
          </Badge>
          <Badge variant="outline">{tr("15秒刷新", "15s refresh")}</Badge>
        </div>
      </div>

      {!data?.monitors.length ? (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CircleAlert className="h-5 w-5 text-amber-400" />
              {tr("尚未设置监控星系", "No monitored systems configured")}
            </CardTitle>
            <CardDescription>
              {tr(
                "请由FC或管理人员在指挥区添加需要监控的星系。",
                "Ask a fleet manager to add systems in the command area.",
              )}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : (
        <>
          <Card className="overflow-hidden border-sky-500/25">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Orbit className="h-5 w-5 text-sky-400" />
                {tr("实时战术星图", "LIVE TACTICAL MAP")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "依据游戏二维星图坐标等比反映实际相对位置；节点大小反映报告敌对或击杀参与人数，风险颜色随有效情报自动更新。",
                  "Uses a proportional in-game 2D map projection to preserve actual relative positions; node size reflects reported hostiles or killmail participants, while risk colors update with active intelligence.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <SystemIntelMap
                monitors={data.monitors}
                events={data.events}
                dashboardData={data}
                zh={zh}
                onSelectMonitor={(id) => setMonitorId(String(id))}
              />
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.monitors.map((monitor) => (
              <MonitorCard key={monitor.id} monitor={monitor} zh={zh} />
            ))}
          </div>
        </>
      )}

      {data?.monitors.length ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Siren className="h-5 w-5 text-rose-400" />
              {tr("实名报告敌对舰队", "Submit named hostile report")}
            </CardTitle>
            <CardDescription>
              {tr(
                "报告会显示当前登录角色，并在有效期结束后自动退出当前警报。",
                "The current character is recorded and the alert expires automatically.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="space-y-2">
                <Label>{tr("星系", "System")}</Label>
                <Select value={monitorId} onValueChange={setMonitorId}>
                  <SelectTrigger>
                    <SelectValue
                      placeholder={tr("选择监控星系", "Select a system")}
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {data.monitors.map((monitor) => (
                      <SelectItem key={monitor.id} value={String(monitor.id)}>
                        {monitor.solarSystemName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>
                  {tr("敌对人数（可选）", "Hostile count (optional)")}
                </Label>
                <Input
                  type="number"
                  min={0}
                  max={1000}
                  value={enemyCount}
                  onChange={(event) => setEnemyCount(event.target.value)}
                  placeholder="12"
                />
              </div>
              <div className="space-y-2">
                <Label>{tr("移动方向（可选）", "Direction (optional)")}</Label>
                <Input
                  value={direction}
                  onChange={(event) => setDirection(event.target.value)}
                  placeholder={tr("例如：向T5ZI-S", "e.g. toward T5ZI-S")}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tr("舰船标签", "Ship tags")}</Label>
              <div className="flex flex-wrap gap-2">
                {SHIP_TAGS.map((tag) => (
                  <Button
                    key={tag}
                    type="button"
                    size="sm"
                    variant={shipTags.includes(tag) ? "default" : "outline"}
                    onClick={() =>
                      setShipTags((current) =>
                        current.includes(tag)
                          ? current.filter((item) => item !== tag)
                          : [...current, tag],
                      )
                    }
                  >
                    {tag}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label>{tr("情报内容", "Intel details")}</Label>
              <Textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                maxLength={2000}
                placeholder={tr(
                  "例如：约12人战列队在星门驻守，带重拦和后勤。",
                  "e.g. roughly 12 battleships holding the gate with HIC and logistics.",
                )}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex max-w-xl items-start gap-2 text-xs text-muted-foreground">
                <Clock3 className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <span>
                  {tr(
                    "自动时长＝5分钟＋每条玩家击杀2分钟＋每3人1分钟（击杀邮件按参与者，人工/频道按报告敌对），合计最长25分钟。",
                    "Automatic duration = 5 minutes + 2 per player kill + 1 per 3 people (killmail participants or reported hostiles), capped at 25 minutes.",
                  )}
                </span>
              </div>
              <Button
                onClick={submit}
                disabled={
                  !monitorId || !message.trim() || createReport.isPending
                }
              >
                <Send className="mr-2 h-4 w-4" />
                {createReport.isPending
                  ? tr("提交中…", "Submitting…")
                  : tr("提交", "Submit")}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-5 w-5 text-primary" />
            {tr("情报时间线", "Intelligence timeline")}
          </CardTitle>
          <CardDescription>
            {tr(
              `当前有效 ${activeEvents.length} 条；保留最近24小时记录。`,
              `${activeEvents.length} active; showing the last 24 hours.`,
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {!data?.events.length ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              {tr("暂无情报记录。", "No intelligence recorded.")}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {data.events.map((event) => (
                <EventRow key={event.id} event={event} zh={zh} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function MonitorCard({
  monitor,
  zh,
}: {
  monitor: SystemMonitorSummary;
  zh: boolean;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const activity = monitor.latestActivity;
  return (
    <Card
      className={
        monitor.risk === "critical"
          ? "border-rose-500/60"
          : monitor.risk === "danger"
            ? "border-orange-500/50"
            : ""
      }
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" />
              {monitor.solarSystemName}
            </CardTitle>
            <CardDescription className="mt-1">
              ID {monitor.solarSystemId}
            </CardDescription>
          </div>
          <Badge variant="outline" className={RISK_STYLE[monitor.risk]}>
            {riskLabel(monitor.risk, zh)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-md border border-border/50 p-3">
          <div className="text-xs text-muted-foreground">
            {monitor.burstWindowMinutes}
            {tr("分钟击杀", "m kills")}
          </div>
          <div className="mt-1 text-xl font-bold font-mono">
            {monitor.recentKillCount}
          </div>
        </div>
        <div className="rounded-md border border-border/50 p-3">
          <div className="text-xs text-muted-foreground">
            {tr("有效警报", "Active alerts")}
          </div>
          <div className="mt-1 text-xl font-bold font-mono">
            {monitor.activeEventCount}
          </div>
        </div>
        <div className="col-span-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {activity ? (
            <>
              <span>
                {tr("跳跃", "Jumps")}: {activity.jumps}
              </span>
              <span>
                {tr("玩家击杀", "Player kills")}:{" "}
                {activity.shipKills + activity.podKills}
              </span>
              <span>
                {tr("统计时间", "Sample")}:{" "}
                {new Date(activity.sampledAt).toLocaleTimeString(
                  zh ? "zh-CN" : undefined,
                  { hour: "2-digit", minute: "2-digit" },
                )}
              </span>
            </>
          ) : (
            <span>
              {tr("正在建立ESI活动基线", "Building ESI activity baseline")}
            </span>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function EventRow({ event, zh }: { event: SystemIntelEvent; zh: boolean }) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const population = eventPopulation(event);
  const expired = Boolean(
    event.expiresAt && new Date(event.expiresAt).getTime() <= Date.now(),
  );
  return (
    <div className={`p-4 ${expired ? "opacity-50" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge variant="outline" className={RISK_STYLE[event.severity]}>
              {event.solarSystemName}
            </Badge>
            <Badge variant="secondary">{sourceLabel(event.source, zh)}</Badge>
            <Badge variant="outline">
              <ShieldCheck className="mr-1 h-3 w-3" />
              {confidenceLabel(event.confidence, zh)}
            </Badge>
            {expired && (
              <Badge variant="outline">{tr("已过期", "EXPIRED")}</Badge>
            )}
          </div>
          <p className="text-sm text-foreground">{event.summary}</p>
          <div className="mt-2 flex flex-wrap gap-3 text-xs text-muted-foreground">
            {population && (
              <span className="flex items-center gap-1">
                <Users className="h-3 w-3" />
                {population.isParticipantCount
                  ? tr("参与", "Participants")
                  : tr("敌对", "Hostiles")}{" "}
                {population.count}
              </span>
            )}
            {event.direction && (
              <span>
                {tr("方向", "Direction")}: {event.direction}
              </span>
            )}
            {event.shipTags.map((tag) => (
              <span key={tag}>#{tag}</span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Clock3 className="h-3 w-3" />
            {new Date(event.occurredAt).toLocaleString(
              zh ? "zh-CN" : undefined,
            )}
          </span>
          {event.zkillboardUrl && (
            <a
              className="flex items-center gap-1 text-primary hover:underline"
              href={event.zkillboardUrl}
              target="_blank"
              rel="noreferrer"
            >
              zKillboard <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
