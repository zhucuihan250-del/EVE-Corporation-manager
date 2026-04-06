import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useGetDashboardSummary, useGetRecentFleets } from "@workspace/api-client-react";
import { Target, Activity, Award, Trophy, Swords } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Link } from "wouter";

export function Dashboard() {
  const { data: summary, isLoading: isSummaryLoading } = useGetDashboardSummary({
    query: {
      queryKey: ["dashboardSummary"]
    }
  });

  const { data: recentFleets, isLoading: isFleetsLoading } = useGetRecentFleets({
    query: {
      queryKey: ["recentFleets"]
    }
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Tactical Overview</h1>
        <p className="text-muted-foreground font-mono text-sm">Real-time participation statistics</p>
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
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">Total PAP</CardTitle>
              <Award className="w-4 h-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalPap}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">Lifetime accumulated</p>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">Redeemable</CardTitle>
              <Trophy className="w-4 h-4 text-emerald-500" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.redeemablePap}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">Available to spend</p>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">Fleets Joined</CardTitle>
              <Target className="w-4 h-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.fleetCount}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">Combat operations</p>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">Recent Earned</CardTitle>
              <Activity className="w-4 h-4 text-purple-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.recentPapEarned}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">Last 30 days</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="bg-card/20 border-border/50 rounded-sm col-span-1 flex flex-col">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center justify-between">
              <span>Recent Operations</span>
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
            ) : !recentFleets?.length ? (
              <div className="p-8 flex-1 flex items-center justify-center text-muted-foreground font-mono text-sm">
                No recent fleet operations.
              </div>
            ) : (
              <div className="divide-y divide-border/30">
                {recentFleets.map((fleet) => (
                  <div key={fleet.id} className="p-4 flex items-center justify-between hover:bg-primary/5 transition-colors group">
                    <div className="flex flex-col">
                      <span className="font-mono text-sm text-foreground font-medium group-hover:text-primary transition-colors">{fleet.name}</span>
                      <span className="font-mono text-xs text-muted-foreground mt-1">FC: {fleet.fleetCommander}</span>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant={fleet.isActive ? 'default' : 'secondary'} className="font-mono text-[10px] rounded-sm">
                        {fleet.isActive ? 'ACTIVE' : 'CONCLUDED'}
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

        <Card className="bg-card/20 border-border/50 rounded-sm col-span-1">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-sm font-mono tracking-wider uppercase">System Broadcasts</CardTitle>
          </CardHeader>
          <CardContent className="h-64 flex flex-col items-center justify-center text-muted-foreground font-mono text-sm">
            <div className="w-12 h-12 rounded-full border border-dashed border-border flex items-center justify-center mb-4">
              <Activity className="w-6 h-6 text-muted-foreground/50" />
            </div>
            <p>No active operations requiring immediate attention.</p>
            <p className="text-xs mt-2 opacity-50">Monitoring alliance frequencies...</p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}