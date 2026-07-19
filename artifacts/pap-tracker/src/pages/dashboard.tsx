import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGetDashboardSummary, useGetRecentFleets, useListAnnouncements, useListFleets } from "@workspace/api-client-react";
import { useLiveFleetCounts } from "@/hooks/use-live-fleet-counts";
import { Target, Activity, Award, Trophy, Swords, Radio, CalendarClock, Shield, Users, TrendingUp } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { apiUrl } from "@/lib/api";

type PapHistoryEntry = { date: string; pap: number };

function usePapHistory() {
  const [data, setData] = useState<PapHistoryEntry[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    fetch(apiUrl("/api/dashboard/pap-history"), { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`PAP history request failed: ${r.status}`);
        return r.json();
      })
      .then((d) => { setData(Array.isArray(d) ? d as PapHistoryEntry[] : []); })
      .catch(() => setData([]))
      .finally(() => setIsLoading(false));
  }, []);

  return { data, isLoading };
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: { value: number }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border/50 rounded-sm px-3 py-2 font-mono text-xs shadow-lg">
      <p className="text-muted-foreground">{label}</p>
      <p className="text-primary font-bold">+{payload[0].value} PAP</p>
    </div>
  );
}

type RallyLevel = "MAX CTA" | "CTA" | "战略" | "散打";
const RALLY_LEVEL_COLORS: Record<RallyLevel, string> = {
  "MAX CTA": "bg-red-500/20 text-red-400 border-red-500/30 border",
  "CTA": "bg-orange-500/20 text-orange-400 border-orange-500/30 border",
  "战略": "bg-yellow-500/20 text-yellow-400 border-yellow-500/30 border",
  "散打": "bg-green-500/20 text-green-400 border-green-500/30 border",
};

export function Dashboard() {
  const { t } = useTranslation();
  const { data: summary, isLoading: isSummaryLoading } = useGetDashboardSummary({
    query: { queryKey: ["dashboardSummary"] }
  });

  const { data: recentFleets, isLoading: isFleetsLoading } = useGetRecentFleets({
    query: { queryKey: ["recentFleets"] }
  });

  const { data: allFleets, isLoading: isActiveFleetsLoading } = useListFleets({
    query: { queryKey: ["dashboardFleets"] }
  });

  const { data: announcements, isLoading: isAnnouncementsLoading } = useListAnnouncements({
    query: { queryKey: ["announcements"] }
  });

  const activeFleets = allFleets?.filter((f) => f.isActive) ?? [];
  const pastFleets = recentFleets?.filter((f) => !f.isActive) ?? [];
  const { liveCounts } = useLiveFleetCounts(activeFleets);
  const { data: papHistory, isLoading: isPapHistoryLoading } = usePapHistory();
  const hasAnyPap = papHistory?.some((d) => d.pap > 0);
  const chartData = papHistory?.map((d) => ({
    date: d.date.slice(5),
    pap: d.pap,
  }));

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("dashboard.title")}</h1>
        <p className="text-muted-foreground font-mono text-sm">{t("dashboard.subtitle")}</p>
      </div>

      {isSummaryLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {[0,1,2,3].map(i => <Skeleton key={i} className="h-32 rounded-sm border border-border/50 bg-card/50" />)}
        </div>
      ) : summary ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Card className="bg-card/40 backdrop-blur border-primary/20 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">{t("dashboard.totalPap")}</CardTitle>
              <Award className="w-4 h-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalPap}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">{t("dashboard.lifetimeAccumulated")}</p>
            </CardContent>
          </Card>
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">{t("dashboard.redeemable")}</CardTitle>
              <Trophy className="w-4 h-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.redeemablePap}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">{t("dashboard.availableToSpend")}</p>
            </CardContent>
          </Card>
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">{t("dashboard.fleetsJoined")}</CardTitle>
              <Target className="w-4 h-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.fleetCount}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">{t("dashboard.combatOperations")}</p>
            </CardContent>
          </Card>
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">{t("dashboard.recentEarned")}</CardTitle>
              <Activity className="w-4 h-4 text-purple-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.recentPapEarned}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">{t("dashboard.last30Days")}</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      {/* PAP Trend Chart */}
      <Card className="bg-card/20 border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-3">
          <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase flex items-center justify-between">
            <span>{t("dashboard.papTrend")}</span>
            <TrendingUp className="w-4 h-4 text-primary" />
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-4 pb-2 px-2">
          {isPapHistoryLoading ? (
            <Skeleton className="h-32 w-full bg-card/50" />
          ) : !hasAnyPap ? (
            <div className="h-32 flex items-center justify-center text-muted-foreground font-mono text-sm">
              {t("dashboard.noPapHistory")}
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={130}>
              <AreaChart data={chartData} margin={{ top: 4, right: 8, left: -28, bottom: 0 }}>
                <defs>
                  <linearGradient id="papGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis
                  dataKey="date"
                  tick={{ fontFamily: "monospace", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  interval={4}
                />
                <YAxis
                  tick={{ fontFamily: "monospace", fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
                  tickLine={false}
                  axisLine={false}
                  allowDecimals={false}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: "hsl(var(--primary))", strokeWidth: 1, strokeDasharray: "4 2" }} />
                <Area
                  type="monotone"
                  dataKey="pap"
                  stroke="hsl(var(--primary))"
                  strokeWidth={1.5}
                  fill="url(#papGradient)"
                  dot={false}
                  activeDot={{ r: 3, fill: "hsl(var(--primary))", strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Active Operations */}
      {(isActiveFleetsLoading || activeFleets.length > 0) && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
            </span>
            <h2 className="text-sm font-mono tracking-wider uppercase text-primary">{t("dashboard.activeOperations")}</h2>
          </div>
          {isActiveFleetsLoading ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <Skeleton className="h-20 rounded-sm border border-primary/20 bg-card/50" />
              <Skeleton className="h-20 rounded-sm border border-primary/20 bg-card/50" />
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {activeFleets.map((fleet) => (
                <Card key={fleet.id} className="bg-primary/5 border-primary/30 rounded-sm">
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1.5">
                          <Badge className="font-mono text-[10px] rounded-sm bg-primary/20 text-primary border border-primary/30 px-1.5 py-0 animate-pulse">
                            ● {t("dashboard.live")}
                          </Badge>
                          <span className="font-mono text-sm font-semibold text-foreground truncate">{fleet.name}</span>
                        </div>
                        <div className="flex items-center gap-3 text-xs font-mono text-muted-foreground flex-wrap">
                          <span className="flex items-center gap-1">
                            <Shield className="w-3 h-3 text-primary/60" /> {fleet.fleetCommander}
                          </span>
                          <span className="flex items-center gap-1">
                            <Users className="w-3 h-3 text-primary/60" /> {liveCounts[fleet.id] ?? fleet.participantCount ?? 0} {t("dashboard.pilots")}
                          </span>
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-2xl font-bold font-mono text-primary">{fleet.papValue}</div>
                        <div className="text-[10px] font-mono text-muted-foreground uppercase">PAP</div>
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] font-mono text-muted-foreground/60">
                      {t("dashboard.startedAt")} {format(new Date(fleet.createdAt), "HH:mm")}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Operations */}
        <Card className="bg-card/20 border-border/50 rounded-sm flex flex-col">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center justify-between">
              <span>{t("dashboard.recentOperations")}</span>
              <Swords className="w-4 h-4 text-muted-foreground" />
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col">
            {isFleetsLoading ? (
              <div className="p-8 flex flex-col gap-4">
                <Skeleton className="h-12 w-full bg-card/50" />
                <Skeleton className="h-12 w-full bg-card/50" />
                <Skeleton className="h-12 w-full bg-card/50" />
              </div>
            ) : !pastFleets.length ? (
              <div className="p-8 flex-1 flex items-center justify-center text-muted-foreground font-mono text-sm">
                {t("dashboard.noRecentFleets")}
              </div>
            ) : (
              <div className="divide-y divide-border/30 overflow-auto max-h-80">
                {pastFleets.slice(0, 10).map((fleet) => (
                  <div key={fleet.id} className="p-4 flex items-center justify-between hover:bg-primary/5 transition-colors group">
                    <div className="flex flex-col">
                      <span className="font-mono text-sm text-foreground font-medium group-hover:text-primary transition-colors">{fleet.name}</span>
                      <span className="font-mono text-xs text-muted-foreground mt-1">{t("dashboard.fc")}: {fleet.fleetCommander}</span>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant="secondary" className="font-mono text-[10px] rounded-sm">{t("dashboard.concluded")}</Badge>
                      <span className="font-mono text-xs text-muted-foreground">{format(new Date(fleet.createdAt), "MMM dd")}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Fleet Notices (舰队预告) */}
        <Card className="bg-card/20 border-border/50 rounded-sm flex flex-col">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center justify-between">
              <span>{t("dashboard.systemBroadcasts")}</span>
              <Radio className="w-4 h-4 text-primary animate-pulse" />
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col">
            {isAnnouncementsLoading ? (
              <div className="p-8 flex flex-col gap-3">
                <Skeleton className="h-16 w-full bg-card/50" />
                <Skeleton className="h-16 w-full bg-card/50" />
              </div>
            ) : !announcements?.length ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground font-mono text-sm">
                <div className="w-12 h-12 rounded-full border border-dashed border-border flex items-center justify-center mb-4">
                  <Radio className="w-6 h-6 text-muted-foreground/50" />
                </div>
                <p>{t("dashboard.noActiveFleets")}</p>
              </div>
            ) : (
              <div className="divide-y divide-border/30 overflow-auto max-h-80">
                {announcements.map((ann) => {
                  const level = ann.rallyLevel as RallyLevel;
                  const colorClass = RALLY_LEVEL_COLORS[level] ?? "bg-muted/20 text-muted-foreground border-border/30 border";
                  return (
                    <div key={ann.id} className="p-4 hover:bg-primary/5 transition-colors">
                      <div className="flex items-center gap-2 mb-2 flex-wrap">
                        <Badge className={`font-mono text-[10px] rounded-sm px-2 py-0.5 ${colorClass}`}>
                          {ann.rallyLevel}
                        </Badge>
                        <div className="flex items-center gap-1 text-muted-foreground font-mono text-xs">
                          <CalendarClock className="w-3 h-3" />
                          {format(new Date(ann.scheduledAt), "MM-dd HH:mm")}
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-xs font-mono">
                        <span className="text-muted-foreground">{t("dashboard.fc")}: <span className="text-foreground">{ann.fc}</span></span>
                        <span className="text-muted-foreground">📍 {ann.rallyPoint}</span>
                      </div>
                      {ann.notes && (
                        <p className="font-mono text-xs text-muted-foreground/70 mt-1 italic">{ann.notes}</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
