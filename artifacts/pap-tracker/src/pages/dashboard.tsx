import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGetDashboardSummary, useGetRecentFleets } from "@workspace/api-client-react";
import { Target, Activity, Award, Trophy, Swords, Radio } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { useTranslation } from "react-i18next";

export function Dashboard() {
  const { t } = useTranslation();
  const { data: summary, isLoading: isSummaryLoading } = useGetDashboardSummary({
    query: { queryKey: ["dashboardSummary"] }
  });

  const { data: recentFleets, isLoading: isFleetsLoading } = useGetRecentFleets({
    query: { queryKey: ["recentFleets"] }
  });

  const activeFleets = recentFleets?.filter((f) => f.isActive) ?? [];
  const pastFleets = recentFleets?.filter((f) => !f.isActive) ?? [];

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("dashboard.title")}</h1>
        <p className="text-muted-foreground font-mono text-sm">{t("dashboard.subtitle")}</p>
      </div>

      {isSummaryLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <Skeleton className="h-32 rounded-sm border border-border/50 bg-card/50" />
          <Skeleton className="h-32 rounded-sm border border-border/50 bg-card/50" />
          <Skeleton className="h-32 rounded-sm border border-border/50 bg-card/50" />
          <Skeleton className="h-32 rounded-sm border border-border/50 bg-card/50" />
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

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Recent Operations */}
        <Card className="bg-card/20 border-border/50 rounded-sm col-span-1 flex flex-col">
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
                      <Badge variant="secondary" className="font-mono text-[10px] rounded-sm">
                        {t("dashboard.concluded")}
                      </Badge>
                      <span className="font-mono text-xs text-muted-foreground">
                        {format(new Date(fleet.createdAt), "MMM dd")}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Fleet Notices (舰队预告) */}
        <Card className="bg-card/20 border-border/50 rounded-sm col-span-1 flex flex-col">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center justify-between">
              <span>{t("dashboard.systemBroadcasts")}</span>
              <Radio className="w-4 h-4 text-primary animate-pulse" />
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0 flex-1 flex flex-col">
            {isFleetsLoading ? (
              <div className="p-8 flex flex-col gap-4">
                <Skeleton className="h-16 w-full bg-card/50" />
                <Skeleton className="h-16 w-full bg-card/50" />
              </div>
            ) : !activeFleets.length ? (
              <div className="flex-1 flex flex-col items-center justify-center p-8 text-muted-foreground font-mono text-sm">
                <div className="w-12 h-12 rounded-full border border-dashed border-border flex items-center justify-center mb-4">
                  <Radio className="w-6 h-6 text-muted-foreground/50" />
                </div>
                <p>{t("dashboard.noActiveFleets")}</p>
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {activeFleets.map((fleet) => (
                  <div key={fleet.id} className="p-4 hover:bg-primary/5 transition-colors">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-primary animate-pulse flex-shrink-0 mt-1" />
                        <span className="font-mono text-sm text-foreground font-semibold">{fleet.name}</span>
                      </div>
                      <Badge className="font-mono text-[10px] rounded-sm bg-primary/20 text-primary border-primary/30 border">
                        {t("dashboard.active")}
                      </Badge>
                    </div>
                    <div className="ml-4 flex items-center justify-between">
                      <span className="font-mono text-xs text-muted-foreground">{t("dashboard.fc")}: {fleet.fleetCommander}</span>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-xs text-primary font-bold">+{fleet.papValue} PAP</span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {t("dashboard.activeFleetSubtitle")}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
