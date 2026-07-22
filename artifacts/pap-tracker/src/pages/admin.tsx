import { useState } from "react";
import {
  useGetAdminSummary,
  useGetTopContributors,
  useGetTopContributors30Days,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Swords, Award, Inbox, Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTranslation } from "react-i18next";

const LEADERBOARD_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export function AdminDashboard() {
  const { t } = useTranslation();
  const [leaderboardPeriod, setLeaderboardPeriod] = useState<"all" | "30-days">("all");
  const { data: summary, isLoading: isSummaryLoading } = useGetAdminSummary({
    query: { queryKey: ["adminSummary"] }
  });
  
  const { data: topContributors, isLoading: isContributorsLoading } = useGetTopContributors({
    query: {
      queryKey: ["topContributors"],
      refetchInterval: LEADERBOARD_REFRESH_INTERVAL_MS,
    }
  });
  const { data: recentTopContributors, isLoading: isRecentContributorsLoading } = useGetTopContributors30Days({
    query: {
      queryKey: ["topContributors", "30-days"],
      refetchInterval: LEADERBOARD_REFRESH_INTERVAL_MS,
    }
  });

  const visibleContributors = leaderboardPeriod === "all" ? topContributors : recentTopContributors;
  const isVisibleLeaderboardLoading = leaderboardPeriod === "all"
    ? isContributorsLoading
    : isRecentContributorsLoading;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("admin.title")}</h1>
        <p className="text-muted-foreground font-mono text-sm">{t("admin.subtitle")}</p>
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
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">{t("admin.activePersonnel")}</CardTitle>
              <Users className="w-4 h-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalUsers}</div>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">{t("admin.totalOperations")}</CardTitle>
              <Swords className="w-4 h-4 text-red-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalFleets}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">{summary.activeFleets} {t("admin.active")}</p>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-primary/20 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-primary tracking-wider uppercase">{t("admin.papDistributed")}</CardTitle>
              <Award className="w-4 h-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-primary">{summary.totalPapAwarded}</div>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">{t("admin.requisitions")}</CardTitle>
              <Inbox className="w-4 h-4 text-emerald-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalRedemptions}</div>
              <p className="text-xs text-emerald-400 mt-1 font-mono">{summary.pendingRedemptions} {t("admin.pending")}</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm col-span-1">
          <CardHeader className="border-b border-border/30 gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
                <Trophy className="w-4 h-4 text-primary" /> {t("admin.topContributors")}
              </CardTitle>
              <p className="mt-1 text-xs font-mono text-muted-foreground">
                {t("admin.leaderboardAutoRefresh")}
              </p>
            </div>
            <Tabs
              value={leaderboardPeriod}
              onValueChange={(value) => setLeaderboardPeriod(value as "all" | "30-days")}
            >
              <TabsList className="rounded-sm">
                <TabsTrigger value="all" className="rounded-sm font-mono text-xs">
                  {t("admin.allTimeLeaderboard")}
                </TabsTrigger>
                <TabsTrigger value="30-days" className="rounded-sm font-mono text-xs">
                  {t("admin.thirtyDayLeaderboard")}
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </CardHeader>
          <CardContent className="p-0">
            {isVisibleLeaderboardLoading ? (
              <div className="p-8 flex flex-col gap-4">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : !visibleContributors?.length ? (
              <div className="p-8 text-center text-muted-foreground font-mono text-sm">
                {t("admin.noActivity")}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border/30 hover:bg-transparent">
                    <TableHead className="font-mono text-xs text-muted-foreground">{t("admin.pilot")}</TableHead>
                    <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("admin.ops")}</TableHead>
                    <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("admin.pap")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleContributors.map((contributor, idx) => (
                    <TableRow key={contributor.userId} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                      <TableCell className="font-mono text-sm text-foreground flex items-center gap-2">
                        <span className="text-muted-foreground w-4">{idx + 1}.</span> {contributor.userName}
                      </TableCell>
                      <TableCell className="font-mono text-right text-muted-foreground">
                        {contributor.fleetCount}
                      </TableCell>
                      <TableCell className="font-mono font-bold text-right text-primary">
                        {contributor.totalPap}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
