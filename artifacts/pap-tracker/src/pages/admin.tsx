import { useGetAdminSummary, useGetTopContributors } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Users, Swords, Award, Inbox, Trophy } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export function AdminDashboard() {
  const { data: summary, isLoading: isSummaryLoading } = useGetAdminSummary({
    query: { queryKey: ["adminSummary"] }
  });
  
  const { data: topContributors, isLoading: isContributorsLoading } = useGetTopContributors({
    query: { queryKey: ["topContributors"] }
  });

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Command Center</h1>
        <p className="text-muted-foreground font-mono text-sm">Alliance level telemetry and metrics</p>
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
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">Active Personnel</CardTitle>
              <Users className="w-4 h-4 text-blue-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalUsers}</div>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">Total Operations</CardTitle>
              <Swords className="w-4 h-4 text-red-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalFleets}</div>
              <p className="text-xs text-muted-foreground mt-1 font-mono">{summary.activeFleets} Active</p>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-primary/20 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-primary tracking-wider uppercase">PAP Distributed</CardTitle>
              <Award className="w-4 h-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-primary">{summary.totalPapAwarded}</div>
            </CardContent>
          </Card>
          
          <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
            <CardHeader className="flex flex-row items-center justify-between pb-2 space-y-0">
              <CardTitle className="text-xs font-mono font-medium text-muted-foreground tracking-wider uppercase">Requisitions</CardTitle>
              <Inbox className="w-4 h-4 text-emerald-400" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold font-mono text-foreground">{summary.totalRedemptions}</div>
              <p className="text-xs text-emerald-400 mt-1 font-mono">{summary.pendingRedemptions} Pending</p>
            </CardContent>
          </Card>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm col-span-1">
          <CardHeader className="border-b border-border/30">
            <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
              <Trophy className="w-4 h-4 text-primary" /> Top Contributors
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isContributorsLoading ? (
              <div className="p-8 flex flex-col gap-4">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : !topContributors?.length ? (
              <div className="p-8 text-center text-muted-foreground font-mono text-sm">
                No activity data available.
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border/30 hover:bg-transparent">
                    <TableHead className="font-mono text-xs text-muted-foreground">PILOT</TableHead>
                    <TableHead className="font-mono text-xs text-muted-foreground text-right">OPS</TableHead>
                    <TableHead className="font-mono text-xs text-muted-foreground text-right">PAP</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {topContributors.map((contributor, idx) => (
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