import {
  getGetBattleReportQueryKey,
  getListBattleReportsQueryKey,
  type BattleReportDetail as BattleReportDetailData,
  type BattleReportSummary,
  useGetBattleReport,
  useGetMe,
  useListBattleReports,
  useRefreshBattleReport,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  ArrowLeft,
  BarChart3,
  Clock3,
  Crosshair,
  ExternalLink,
  Loader2,
  MapPin,
  RefreshCw,
  Shield,
  Skull,
  Swords,
  Target,
  Users,
  Zap,
} from "lucide-react";
import { Link, useParams } from "wouter";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";

const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;

function formatIsk(value: number): string {
  if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(2)}t`;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

function formatNumber(value: number): string {
  return Math.round(value).toLocaleString();
}

function efficiency(report: Pick<BattleReportSummary, "totalDestroyed" | "totalLost">): number {
  const total = report.totalDestroyed + report.totalLost;
  return total > 0 ? (report.totalDestroyed / total) * 100 : 0;
}

function durationLabel(startedAt: string, endedAt: string): string {
  const minutes = Math.max(0, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 60_000));
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  if (!hours) return `${remainder}m`;
  return remainder ? `${hours}h ${remainder}m` : `${hours}h`;
}

function statusBadge(status: BattleReportSummary["status"], label: string) {
  const className = status === "ready"
    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
    : status === "failed"
      ? "border-red-500/30 bg-red-500/10 text-red-400"
      : status === "partial"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
        : "border-primary/30 bg-primary/10 text-primary";
  return <Badge variant="outline" className={`rounded-sm font-mono text-[10px] ${className}`}>{label}</Badge>;
}

function BattleReportLoading() {
  return (
    <div className="min-h-[320px] flex items-center justify-center">
      <Loader2 className="w-7 h-7 animate-spin text-primary" />
    </div>
  );
}

export function BattleReports() {
  const { t } = useTranslation();
  const { data: reports, isLoading } = useListBattleReports({
    query: { queryKey: getListBattleReportsQueryKey(), refetchInterval: 15_000 },
  });
  const reportList = Array.isArray(reports) ? reports : [];

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase flex items-center gap-3">
          <Crosshair className="w-6 h-6 text-primary" />
          {t("battleReports.title")}
        </h1>
        <p className="text-muted-foreground font-mono text-sm">{t("battleReports.subtitle")}</p>
      </div>

      {isLoading ? (
        <BattleReportLoading />
      ) : reportList.length === 0 ? (
        <Card className="bg-card/30 border-dashed border-border/50 rounded-sm">
          <CardContent className="py-16 text-center">
            <Crosshair className="w-10 h-10 text-muted-foreground/30 mx-auto mb-4" />
            <p className="font-mono text-sm text-muted-foreground">{t("battleReports.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reportList.map((report) => (
            <Link key={report.id} href={`/battle-reports/${report.id}`}>
              <Card className="group bg-card/35 hover:bg-card/60 border-border/50 hover:border-primary/35 rounded-sm transition-all cursor-pointer overflow-hidden">
                <CardContent className="p-0">
                  <div className="grid grid-cols-1 lg:grid-cols-[1.3fr_1fr_1fr] divide-y lg:divide-y-0 lg:divide-x divide-border/30">
                    <div className="p-5 space-y-3">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h2 className="font-mono font-bold text-base text-foreground group-hover:text-primary transition-colors">
                            {report.fleetName}
                          </h2>
                          <p className="font-mono text-xs text-muted-foreground mt-1">
                            {format(new Date(report.startedAt), "yyyy-MM-dd HH:mm")} – {format(new Date(report.endedAt), "HH:mm")}
                          </p>
                        </div>
                        {statusBadge(report.status, t(`battleReports.status.${report.status}`))}
                      </div>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 font-mono text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-primary" />{report.primarySystemName || t("battleReports.unknownSystem")}</span>
                        <span className="inline-flex items-center gap-1.5"><Clock3 className="w-3.5 h-3.5" />{durationLabel(report.startedAt, report.endedAt)}</span>
                        <span className="inline-flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" />{report.fleetCommander}</span>
                      </div>
                    </div>
                    <div className="p-5 flex flex-col justify-center">
                      <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{t("battleReports.destroyed")}</p>
                      <p className="font-mono text-xl font-bold text-emerald-400">{formatIsk(report.totalDestroyed)} ISK</p>
                      <p className="font-mono text-xs text-muted-foreground mt-1">{t("battleReports.killmailsCount", { count: report.killmailCount })}</p>
                    </div>
                    <div className="p-5 flex items-center justify-between gap-4">
                      <div>
                        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{t("battleReports.involved")}</p>
                        <p className="font-mono text-xl font-bold text-foreground">{report.participantCount}</p>
                        <p className="font-mono text-xs text-muted-foreground">{t("battleReports.pilots")}</p>
                      </div>
                      <div className="text-right">
                        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground mb-1">{t("battleReports.efficiency")}</p>
                        <p className="font-mono text-xl font-bold text-primary">{efficiency(report).toFixed(1)}%</p>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryMetric({ icon: Icon, label, value, tone = "text-foreground" }: {
  icon: typeof Target;
  label: string;
  value: string;
  tone?: string;
}) {
  return (
    <Card className="bg-card/35 border-border/50 rounded-sm">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{label}</span>
          <Icon className="w-4 h-4 text-primary" />
        </div>
        <p className={`font-mono text-2xl font-bold ${tone}`}>{value}</p>
      </CardContent>
    </Card>
  );
}

function TeamCard({ title, pilotCount, iskLost, shipsLost, efficiencyValue, friendly }: {
  title: string;
  pilotCount: number;
  iskLost: number;
  shipsLost: number;
  efficiencyValue: number;
  friendly: boolean;
}) {
  const { t } = useTranslation();
  return (
    <Card className={`bg-card/35 rounded-sm ${friendly ? "border-primary/30" : "border-red-500/25"}`}>
      <CardHeader className="pb-3 border-b border-border/30">
        <CardTitle className="font-mono text-sm flex items-center justify-between">
          <span className={friendly ? "text-primary" : "text-red-400"}>{title}</span>
          <Badge variant="secondary" className="font-mono rounded-sm">{pilotCount}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 grid grid-cols-2 gap-4">
        <div><p className="font-mono text-[10px] text-muted-foreground uppercase">{t("battleReports.iskLost")}</p><p className="font-mono font-bold mt-1">{formatIsk(iskLost)}</p></div>
        <div><p className="font-mono text-[10px] text-muted-foreground uppercase">{t("battleReports.teamEfficiency")}</p><p className="font-mono font-bold mt-1">{efficiencyValue.toFixed(1)}%</p></div>
        <div><p className="font-mono text-[10px] text-muted-foreground uppercase">{t("battleReports.shipsLost")}</p><p className="font-mono font-bold mt-1">{shipsLost}</p></div>
        <div><p className="font-mono text-[10px] text-muted-foreground uppercase">{t("battleReports.pilots")}</p><p className="font-mono font-bold mt-1">{pilotCount}</p></div>
      </CardContent>
    </Card>
  );
}

function PilotTable({ report, compact = false }: { report: BattleReportDetailData; compact?: boolean }) {
  const { t } = useTranslation();
  const pilots = compact ? report.participants.slice(0, 8) : report.participants;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow className="border-border/30 hover:bg-transparent">
            <TableHead className="font-mono text-xs">{t("battleReports.pilot")}</TableHead>
            <TableHead className="font-mono text-xs">{t("battleReports.ship")}</TableHead>
            <TableHead className="font-mono text-xs text-right">{t("battleReports.damage")}</TableHead>
            <TableHead className="font-mono text-xs text-right">{t("battleReports.kills")}</TableHead>
            <TableHead className="font-mono text-xs text-right">{t("battleReports.finalBlows")}</TableHead>
            <TableHead className="font-mono text-xs text-right">{t("battleReports.losses")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pilots.map((pilot) => (
            <TableRow key={pilot.id} className="border-border/25">
              <TableCell>
                <div className="flex items-center gap-3 min-w-[180px]">
                  <img src={`https://images.evetech.net/characters/${pilot.eveCharacterId}/portrait?size=64`} alt="" className="w-8 h-8 rounded-sm bg-muted" />
                  <div><p className="font-mono text-sm text-foreground">{pilot.characterName}</p><p className="font-mono text-[10px] text-muted-foreground">{pilot.corporationName || "—"}</p></div>
                </div>
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-2 min-w-[120px]">
                  {pilot.primaryShipTypeId ? <img src={`https://images.evetech.net/types/${pilot.primaryShipTypeId}/icon?size=64`} alt="" className="w-7 h-7" /> : null}
                  <span className="font-mono text-xs text-muted-foreground">{pilot.primaryShipName || t("battleReports.noCombatShip")}</span>
                </div>
              </TableCell>
              <TableCell className="font-mono text-xs text-right">{formatNumber(pilot.damageDealt)}</TableCell>
              <TableCell className="font-mono text-xs text-right">{pilot.killsInvolved}</TableCell>
              <TableCell className="font-mono text-xs text-right text-primary">{pilot.finalBlows}</TableCell>
              <TableCell className="font-mono text-xs text-right text-red-400">{pilot.losses}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function BattleReportDetail() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const reportId = Number(id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data: user } = useGetMe();
  const { data: report, isLoading, isError } = useGetBattleReport(reportId, {
    query: { queryKey: getGetBattleReportQueryKey(reportId), refetchInterval: 7_500 },
  });
  const refresh = useRefreshBattleReport();
  const canRefresh = user ? ROLE_LEVELS.indexOf(user.role as (typeof ROLE_LEVELS)[number]) >= ROLE_LEVELS.indexOf("fc") : false;

  if (isLoading) return <BattleReportLoading />;
  if (isError || !report) {
    return <div className="py-16 text-center font-mono text-sm text-muted-foreground">{t("battleReports.notFound")}</div>;
  }

  const totalEfficiency = efficiency(report);
  const hostilePilotCount = new Set(report.killmails.filter((killmail) => !killmail.victimIsFleetMember).map((killmail) => killmail.victimCharacterId || `ship-${killmail.id}`)).size;
  const compositions = [...report.participants.reduce((map, pilot) => {
    const key = pilot.primaryShipTypeId ?? 0;
    const entry = map.get(key) ?? { typeId: pilot.primaryShipTypeId, name: pilot.primaryShipName || t("battleReports.noCombatShip"), count: 0 };
    entry.count++;
    map.set(key, entry);
    return map;
  }, new Map<number, { typeId?: number | null; name: string; count: number }>()).values()].sort((left, right) => right.count - left.count);

  const handleRefresh = () => {
    refresh.mutate({ id: report.id }, {
      onSuccess: () => {
        toast({ title: t("battleReports.refreshQueued"), description: t("battleReports.refreshQueuedDesc") });
        queryClient.invalidateQueries({ queryKey: getGetBattleReportQueryKey(report.id) });
        queryClient.invalidateQueries({ queryKey: getListBattleReportsQueryKey() });
      },
      onError: () => toast({ title: t("battleReports.refreshFailed"), variant: "destructive" }),
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div>
          <Link href="/battle-reports">
            <Button variant="ghost" size="sm" className="font-mono text-xs text-muted-foreground -ml-3 mb-2"><ArrowLeft className="w-4 h-4 mr-2" />{t("battleReports.back")}</Button>
          </Link>
          <div className="flex items-center flex-wrap gap-3">
            <h1 className="text-2xl font-bold font-mono tracking-wider uppercase">{report.fleetName}</h1>
            {statusBadge(report.status, t(`battleReports.status.${report.status}`))}
          </div>
          <div className="flex flex-wrap gap-x-5 gap-y-2 mt-3 font-mono text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-primary" />{report.primarySystemName || t("battleReports.unknownSystem")}</span>
            <span className="inline-flex items-center gap-1.5"><Clock3 className="w-3.5 h-3.5" />{format(new Date(report.startedAt), "yyyy-MM-dd HH:mm")} – {format(new Date(report.endedAt), "HH:mm")} · {durationLabel(report.startedAt, report.endedAt)}</span>
            <span className="inline-flex items-center gap-1.5"><Shield className="w-3.5 h-3.5" />{report.fleetCommander}</span>
          </div>
        </div>
        {canRefresh && (
          <Button variant="outline" size="sm" className="font-mono text-xs rounded-sm" onClick={handleRefresh} disabled={refresh.isPending || report.status === "generating"}>
            <RefreshCw className={`w-4 h-4 mr-2 ${(refresh.isPending || report.status === "generating") ? "animate-spin" : ""}`} />
            {t("battleReports.refresh")}
          </Button>
        )}
      </div>

      {(report.status === "pending" || report.status === "generating") && (
        <div className="border border-primary/25 bg-primary/5 rounded-sm p-3 flex items-center gap-3 font-mono text-xs text-primary">
          <Loader2 className="w-4 h-4 animate-spin" />{t("battleReports.generatingNotice")}
        </div>
      )}
      {report.errorMessage && report.status !== "generating" && (
        <div className="border border-amber-500/25 bg-amber-500/5 rounded-sm p-3 font-mono text-xs text-amber-400">
          {t("battleReports.partialNotice")}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <SummaryMetric icon={Target} label={t("battleReports.destroyed")} value={`${formatIsk(report.totalDestroyed)} ISK`} tone="text-emerald-400" />
        <SummaryMetric icon={Skull} label={t("battleReports.lost")} value={`${formatIsk(report.totalLost)} ISK`} tone="text-red-400" />
        <SummaryMetric icon={Zap} label={t("battleReports.efficiency")} value={`${totalEfficiency.toFixed(1)}%`} tone="text-primary" />
        <SummaryMetric icon={Users} label={t("battleReports.involved")} value={`${report.participantCount} / ${report.killmailCount}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TeamCard title={t("battleReports.fleetTeam")} pilotCount={report.participantCount} iskLost={report.totalLost} shipsLost={report.friendlyLosses} efficiencyValue={totalEfficiency} friendly />
        <TeamCard title={t("battleReports.opposingTeam")} pilotCount={hostilePilotCount} iskLost={report.totalDestroyed} shipsLost={report.hostileLosses} efficiencyValue={100 - totalEfficiency} friendly={false} />
      </div>

      <Tabs defaultValue="summary" className="space-y-4">
        <TabsList className="bg-card/50 border border-border/50 rounded-sm h-auto flex-wrap">
          <TabsTrigger value="summary" className="font-mono text-xs rounded-sm"><BarChart3 className="w-3.5 h-3.5 mr-2" />{t("battleReports.summary")}</TabsTrigger>
          <TabsTrigger value="timeline" className="font-mono text-xs rounded-sm"><Clock3 className="w-3.5 h-3.5 mr-2" />{t("battleReports.timeline")}</TabsTrigger>
          <TabsTrigger value="pilots" className="font-mono text-xs rounded-sm"><Users className="w-3.5 h-3.5 mr-2" />{t("battleReports.fleetMembers")}</TabsTrigger>
        </TabsList>

        <TabsContent value="summary" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-[0.8fr_1.6fr] gap-4">
            <Card className="bg-card/35 border-border/50 rounded-sm">
              <CardHeader className="border-b border-border/30 pb-3"><CardTitle className="font-mono text-sm uppercase">{t("battleReports.composition")}</CardTitle></CardHeader>
              <CardContent className="p-4 space-y-3">
                {compositions.map((ship) => (
                  <div key={ship.typeId ?? 0} className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      {ship.typeId ? <img src={`https://images.evetech.net/types/${ship.typeId}/icon?size=64`} alt="" className="w-9 h-9" /> : <Swords className="w-8 h-8 p-1.5 text-muted-foreground" />}
                      <span className="font-mono text-xs truncate">{ship.name}</span>
                    </div>
                    <Badge variant="secondary" className="font-mono rounded-sm">{ship.count}</Badge>
                  </div>
                ))}
              </CardContent>
            </Card>
            <Card className="bg-card/35 border-border/50 rounded-sm">
              <CardHeader className="border-b border-border/30 pb-3"><CardTitle className="font-mono text-sm uppercase">{t("battleReports.topPilots")}</CardTitle></CardHeader>
              <CardContent className="p-0"><PilotTable report={report} compact /></CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="timeline">
          <Card className="bg-card/35 border-border/50 rounded-sm">
            <CardHeader className="border-b border-border/30 pb-3"><CardTitle className="font-mono text-sm uppercase">{t("battleReports.killmailTimeline")}</CardTitle></CardHeader>
            <CardContent className="p-0 overflow-x-auto">
              {report.killmails.length === 0 ? <div className="p-10 text-center font-mono text-sm text-muted-foreground">{t("battleReports.noKillmails")}</div> : (
                <Table>
                  <TableHeader><TableRow className="border-border/30 hover:bg-transparent"><TableHead className="font-mono text-xs">{t("battleReports.time")}</TableHead><TableHead className="font-mono text-xs">{t("battleReports.victim")}</TableHead><TableHead className="font-mono text-xs">{t("battleReports.ship")}</TableHead><TableHead className="font-mono text-xs">{t("battleReports.system")}</TableHead><TableHead className="font-mono text-xs text-right">ISK</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {report.killmails.map((killmail) => (
                      <TableRow key={killmail.id} className="border-border/25">
                        <TableCell className="font-mono text-xs whitespace-nowrap">{format(new Date(killmail.killmailTime), "HH:mm:ss")}</TableCell>
                        <TableCell><div className="min-w-[170px]"><p className={`font-mono text-sm ${killmail.victimIsFleetMember ? "text-red-400" : "text-emerald-400"}`}>{killmail.victimCharacterName || t("battleReports.unknownVictim")}</p><p className="font-mono text-[10px] text-muted-foreground">{killmail.victimAllianceName || killmail.victimCorporationName || "—"}</p></div></TableCell>
                        <TableCell><div className="flex items-center gap-2 min-w-[130px]"><img src={`https://images.evetech.net/types/${killmail.victimShipTypeId}/icon?size=64`} alt="" className="w-8 h-8" /><span className="font-mono text-xs">{killmail.victimShipName || `Type ${killmail.victimShipTypeId}`}</span></div></TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">{killmail.solarSystemName || killmail.solarSystemId}</TableCell>
                        <TableCell className="text-right"><a href={killmail.zkillboardUrl || undefined} target="_blank" rel="noreferrer" className="font-mono text-xs text-primary hover:underline inline-flex items-center gap-1">{formatIsk(killmail.totalValue)}<ExternalLink className="w-3 h-3" /></a></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="pilots">
          <Card className="bg-card/35 border-border/50 rounded-sm"><CardContent className="p-0"><PilotTable report={report} /></CardContent></Card>
        </TabsContent>
      </Tabs>

      {report.lastSyncedAt && <p className="text-right font-mono text-[10px] text-muted-foreground">{t("battleReports.lastSynced", { time: format(new Date(report.lastSyncedAt), "yyyy-MM-dd HH:mm:ss") })}</p>}
    </div>
  );
}
