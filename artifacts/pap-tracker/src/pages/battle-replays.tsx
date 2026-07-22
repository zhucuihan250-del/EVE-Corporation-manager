import { useEffect, useState } from "react";
import { format } from "date-fns";
import {
  getGetBattleReplayQueryKey,
  getListBattleReplaysQueryKey,
  type BattleReviewManualNode,
  useAnalyzeBattleReplay,
  useGetBattleReplay,
  useListBattleReplays,
  useUpdateBattleReplay,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BrainCircuit,
  CheckCircle2,
  Clock3,
  Crosshair,
  ExternalLink,
  FileEdit,
  Flame,
  Loader2,
  Plus,
  Save,
  Ship,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import { Link, useParams } from "wouter";
import { useTranslation } from "react-i18next";
import { BattleReplayPlayer } from "@/components/battle-replay-player";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";

function formatIsk(value: number): string {
  if (value >= 1_000_000_000_000)
    return `${(value / 1_000_000_000_000).toFixed(2)}t`;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  return Math.round(value).toLocaleString();
}

function newNode(occurredAt: string): BattleReviewManualNode {
  return {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `node-${Date.now()}`,
    category: "note",
    occurredAt,
    title: "",
    description: "",
  };
}

function reviewBadge(
  status: "not_started" | "draft" | "published",
  labels: Record<string, string>,
) {
  const className =
    status === "published"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
      : status === "draft"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-400"
        : "border-border/50 text-muted-foreground";
  return (
    <Badge
      variant="outline"
      className={`rounded-sm font-mono text-[10px] ${className}`}
    >
      {labels[status]}
    </Badge>
  );
}

export function BattleReplays() {
  const { t } = useTranslation();
  const { data: reports, isLoading } = useListBattleReplays({
    query: {
      queryKey: getListBattleReplaysQueryKey(),
      refetchInterval: 10_000,
    },
  });
  const reportList = Array.isArray(reports) ? reports : [];
  const labels = {
    not_started: t("battleReplay.status.notStarted"),
    draft: t("battleReplay.status.draft"),
    published: t("battleReplay.status.published"),
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider uppercase flex items-center gap-3">
          <BrainCircuit className="w-6 h-6 text-primary" />
          {t("battleReplay.title")}
        </h1>
        <p className="text-muted-foreground font-mono text-sm mt-1">
          {t("battleReplay.subtitle")}
        </p>
      </div>
      {isLoading ? (
        <div className="py-20 flex justify-center">
          <Loader2 className="w-7 h-7 animate-spin text-primary" />
        </div>
      ) : reportList.length === 0 ? (
        <Card className="bg-card/30 border-dashed rounded-sm">
          <CardContent className="py-16 text-center font-mono text-sm text-muted-foreground">
            {t("battleReplay.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {reportList.map((report) => (
            <Link key={report.id} href={`/command/battle-replays/${report.id}`}>
              <Card className="group bg-card/35 hover:bg-card/60 border-border/50 hover:border-primary/35 rounded-sm transition-all cursor-pointer">
                <CardContent className="p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                  <div>
                    <div className="flex items-center flex-wrap gap-3">
                      <h2 className="font-mono font-bold group-hover:text-primary">
                        {report.fleetName}
                      </h2>
                      {reviewBadge(report.reviewStatus, labels)}
                    </div>
                    <p className="font-mono text-xs text-muted-foreground mt-2">
                      {format(new Date(report.startedAt), "yyyy-MM-dd HH:mm")} ·{" "}
                      {report.primarySystemName ||
                        t("battleReports.unknownSystem")}{" "}
                      · FC {report.fleetCommander}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-5 font-mono text-xs">
                    <span>
                      <span className="text-muted-foreground">
                        {t("battleReports.destroyed")}
                      </span>{" "}
                      <strong className="text-emerald-400 ml-1">
                        {formatIsk(report.totalDestroyed)}
                      </strong>
                    </span>
                    <span>
                      <span className="text-muted-foreground">
                        {t("battleReports.lost")}
                      </span>{" "}
                      <strong className="text-red-400 ml-1">
                        {formatIsk(report.totalLost)}
                      </strong>
                    </span>
                    <Badge
                      variant="outline"
                      className={
                        report.aiStatus === "generating"
                          ? "text-primary border-primary/30"
                          : "text-muted-foreground"
                      }
                    >
                      {report.aiStatus === "generating" && (
                        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
                      )}
                      {t(`battleReplay.aiStatus.${report.aiStatus}`)}
                    </Badge>
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

export function BattleReplayWorkbench() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const reportId = Number(id);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const {
    data: report,
    isLoading,
    isError,
  } = useGetBattleReplay(reportId, {
    query: {
      queryKey: getGetBattleReplayQueryKey(reportId),
      refetchInterval: 3_000,
    },
  });
  const analyze = useAnalyzeBattleReplay();
  const update = useUpdateBattleReplay();
  const [conclusion, setConclusion] = useState("");
  const [manualNodes, setManualNodes] = useState<BattleReviewManualNode[]>([]);
  const [currentEventTime, setCurrentEventTime] = useState<string | null>(null);
  const [loadedReviewKey, setLoadedReviewKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    const key = report?.review?.updatedAt ?? `empty-${report?.id ?? "none"}`;
    if (!report || dirty || loadedReviewKey === key) return;
    setConclusion(report.review?.conclusion ?? "");
    setManualNodes(report.review?.manualNodes ?? []);
    setLoadedReviewKey(key);
  }, [dirty, loadedReviewKey, report]);

  if (isLoading)
    return (
      <div className="py-20 flex justify-center">
        <Loader2 className="w-7 h-7 animate-spin text-primary" />
      </div>
    );
  if (isError || !report)
    return (
      <div className="py-16 text-center font-mono text-sm text-muted-foreground">
        {t("battleReports.notFound")}
      </div>
    );

  const analysis = report.review?.aiAnalysis;
  const aiStatus = report.review?.aiStatus ?? "not_started";

  const invalidate = () => {
    queryClient.invalidateQueries({
      queryKey: getGetBattleReplayQueryKey(report.id),
    });
    queryClient.invalidateQueries({ queryKey: getListBattleReplaysQueryKey() });
  };

  const handleAnalyze = () => {
    analyze.mutate(
      { id: report.id },
      {
        onSuccess: () => {
          toast({
            title: t("battleReplay.analysisQueued"),
            description: t("battleReplay.analysisQueuedDesc"),
          });
          invalidate();
        },
        onError: () =>
          toast({
            title: t("battleReplay.analysisFailed"),
            variant: "destructive",
          }),
      },
    );
  };

  const save = (status: "draft" | "published") => {
    const cleanedNodes = manualNodes
      .filter((node) => node.title.trim())
      .map((node) => ({
        ...node,
        title: node.title.trim(),
        description: node.description.trim(),
      }));
    update.mutate(
      {
        id: report.id,
        data: { status, conclusion, manualNodes: cleanedNodes },
      },
      {
        onSuccess: (saved) => {
          setManualNodes(cleanedNodes);
          setDirty(false);
          setLoadedReviewKey(saved.updatedAt);
          toast({
            title:
              status === "published"
                ? t("battleReplay.published")
                : t("battleReplay.draftSaved"),
          });
          invalidate();
        },
        onError: () =>
          toast({
            title: t("battleReplay.saveFailed"),
            variant: "destructive",
          }),
      },
    );
  };

  const updateNode = (
    index: number,
    patch: Partial<BattleReviewManualNode>,
  ) => {
    setManualNodes((nodes) =>
      nodes.map((node, nodeIndex) =>
        nodeIndex === index ? { ...node, ...patch } : node,
      ),
    );
    setDirty(true);
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-4">
        <div>
          <Link href="/command/battle-replays">
            <Button
              variant="ghost"
              size="sm"
              className="font-mono text-xs text-muted-foreground -ml-3 mb-2"
            >
              <ArrowLeft className="w-4 h-4 mr-2" />
              {t("battleReplay.back")}
            </Button>
          </Link>
          <h1 className="text-2xl font-bold font-mono tracking-wider uppercase">
            {report.fleetName}
          </h1>
          <p className="font-mono text-xs text-muted-foreground mt-2">
            {format(new Date(report.startedAt), "yyyy-MM-dd HH:mm")} –{" "}
            {format(new Date(report.endedAt), "HH:mm")} ·{" "}
            {report.primarySystemName || t("battleReports.unknownSystem")} · FC{" "}
            {report.fleetCommander}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href={`/battle-reports/${report.id}`}>
            <Button
              variant="outline"
              size="sm"
              className="rounded-sm font-mono text-xs"
            >
              <ExternalLink className="w-4 h-4 mr-2" />
              {t("battleReplay.openReport")}
            </Button>
          </Link>
          <Button
            size="sm"
            className="rounded-sm font-mono text-xs"
            onClick={handleAnalyze}
            disabled={
              analyze.isPending ||
              aiStatus === "generating" ||
              report.killmails.length === 0
            }
          >
            {analyze.isPending || aiStatus === "generating" ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4 mr-2" />
            )}
            {aiStatus === "ready"
              ? t("battleReplay.reanalyze")
              : t("battleReplay.analyze")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          [
            Target,
            t("battleReports.destroyed"),
            `${formatIsk(report.totalDestroyed)} ISK`,
            "text-emerald-400",
          ],
          [
            Flame,
            t("battleReports.lost"),
            `${formatIsk(report.totalLost)} ISK`,
            "text-red-400",
          ],
          [
            Crosshair,
            t("battleReports.timeline"),
            `${report.killmailCount}`,
            "text-primary",
          ],
          [
            Clock3,
            t("battleReplay.reviewStatus"),
            t(
              `battleReplay.status.${report.review?.status === "published" ? "published" : report.review ? "draft" : "notStarted"}`,
            ),
            "text-foreground",
          ],
        ].map(([Icon, label, value, tone]) => (
          <Card
            key={String(label)}
            className="bg-card/35 border-border/50 rounded-sm"
          >
            <CardContent className="p-4">
              <div className="flex justify-between">
                <span className="font-mono text-[10px] uppercase text-muted-foreground">
                  {String(label)}
                </span>
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <p className={`font-mono text-xl font-bold mt-3 ${tone}`}>
                {String(value)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1.65fr_0.85fr] gap-4 items-start">
        <Card className="bg-card/35 border-border/50 rounded-sm">
          <CardHeader className="border-b border-border/30 pb-3">
            <CardTitle className="font-mono text-sm uppercase">
              {t("battleReplay.player")}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4">
            <BattleReplayPlayer
              killmails={report.killmails}
              participants={report.participants}
              startedAt={report.startedAt}
              endedAt={report.endedAt}
              analysis={analysis}
              manualNodes={manualNodes}
              onEventChange={setCurrentEventTime}
            />
          </CardContent>
        </Card>
        <div className="space-y-4">
          <Card className="bg-card/35 border-primary/25 rounded-sm">
            <CardHeader className="border-b border-border/30 pb-3">
              <CardTitle className="font-mono text-sm uppercase flex items-center gap-2">
                <BrainCircuit className="w-4 h-4 text-primary" />
                {t("battleReplay.aiAnalysis")}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-4">
              {aiStatus === "not_started" && (
                <p className="font-mono text-xs text-muted-foreground">
                  {t("battleReplay.noAnalysis")}
                </p>
              )}
              {aiStatus === "generating" && (
                <div className="flex items-center gap-2 font-mono text-xs text-primary">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t("battleReplay.analyzing")}
                </div>
              )}
              {aiStatus === "failed" && (
                <p className="font-mono text-xs text-red-400">
                  {t("battleReplay.analysisFailed")}
                </p>
              )}
              {analysis && (
                <>
                  <div className="flex flex-wrap gap-2">
                    <Badge
                      variant="outline"
                      className="border-primary/30 text-primary"
                    >
                      {analysis.source === "openai"
                        ? t("battleReplay.openAiSource")
                        : t("battleReplay.rulesAnalysis")}
                    </Badge>
                    <Badge variant="outline">{analysis.model}</Badge>
                  </div>
                  {analysis.source === "rules" && (
                    <div className="border border-amber-500/25 bg-amber-500/5 rounded-sm p-3 text-xs text-amber-300">
                      {t("battleReplay.fallbackNotice")}
                    </div>
                  )}
                  <p className="text-sm leading-6">{analysis.summary}</p>
                  <div>
                    <h3 className="font-mono text-xs uppercase text-muted-foreground mb-2">
                      {t("battleReplay.aiSuggestions")}
                    </h3>
                    <div className="space-y-2">
                      {analysis.suggestions.map((suggestion, index) => (
                        <div
                          key={`${suggestion.title}-${index}`}
                          className="border border-border/40 rounded-sm p-3"
                        >
                          <p className="font-mono text-xs font-bold">
                            {suggestion.title}
                          </p>
                          <div className="mt-2 space-y-2 text-xs text-muted-foreground">
                            <p>
                              <span className="font-mono text-[10px] text-foreground/70">
                                {t("battleReplay.observation")}:
                              </span>{" "}
                              {suggestion.observation}
                            </p>
                            <p>
                              <span className="font-mono text-[10px] text-emerald-400/80">
                                {t("battleReplay.evidence")}:
                              </span>{" "}
                              {suggestion.evidence}
                            </p>
                            <p>
                              <span className="font-mono text-[10px] text-primary">
                                {t("battleReplay.recommendation")}:
                              </span>{" "}
                              {suggestion.recommendation}
                            </p>
                          </div>
                          <p className="font-mono text-[10px] text-primary mt-2">
                            {t("battleReplay.confidence", {
                              value: Math.round(suggestion.confidence * 100),
                            })}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                  {(analysis.dataQuality?.limitations.length ?? 0) > 0 && (
                    <div className="border border-amber-500/20 bg-amber-500/5 rounded-sm p-3">
                      <h3 className="font-mono text-[10px] uppercase text-amber-300 mb-2">
                        {t("battleReplay.dataBoundaries")}
                      </h3>
                      <ul className="space-y-1.5 text-xs text-muted-foreground">
                        {analysis.dataQuality!.limitations.map(
                          (limitation, index) => (
                            <li key={index}>• {limitation}</li>
                          ),
                        )}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {analysis && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <AnalysisGroup
            icon={Ship}
            title={t("battleReplay.keyShips")}
            items={analysis.keyShips.map((event) => ({
              id: event.killmailId,
              title: event.title,
              description: event.reason,
              time: event.occurredAt,
              confidence: event.confidence,
              evidenceLevel: event.evidenceLevel,
              evidence: event.evidence,
            }))}
          />
          <AnalysisGroup
            icon={Target}
            title={t("battleReplay.keyKills")}
            items={analysis.keyKills.map((event) => ({
              id: event.killmailId,
              title: event.title,
              description: event.reason,
              time: event.occurredAt,
              confidence: event.confidence,
              evidenceLevel: event.evidenceLevel,
              evidence: event.evidence,
            }))}
          />
          <AnalysisGroup
            icon={Flame}
            title={t("battleReplay.lossPeaks")}
            items={analysis.lossPeaks.map((peak, index) => ({
              id: index,
              title: peak.title,
              description: peak.reason,
              time: peak.startedAt,
              confidence: peak.confidence,
              evidenceLevel: peak.evidenceLevel,
              evidence: peak.evidence,
            }))}
          />
        </div>
      )}

      <Card className="bg-card/35 border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-3 flex-row items-center justify-between">
          <CardTitle className="font-mono text-sm uppercase flex items-center gap-2">
            <FileEdit className="w-4 h-4 text-primary" />
            {t("battleReplay.fcNodes")}
          </CardTitle>
          <Button
            variant="outline"
            size="sm"
            className="rounded-sm font-mono text-xs"
            onClick={() => {
              setManualNodes((nodes) => [
                ...nodes,
                newNode(currentEventTime || report.startedAt),
              ]);
              setDirty(true);
            }}
          >
            <Plus className="w-4 h-4 mr-2" />
            {t("battleReplay.addNode")}
          </Button>
        </CardHeader>
        <CardContent className="p-5 space-y-4">
          {manualNodes.length === 0 && (
            <p className="font-mono text-xs text-muted-foreground">
              {t("battleReplay.noNodes")}
            </p>
          )}
          {manualNodes.map((node, index) => (
            <div
              key={node.id}
              className="border border-border/40 rounded-sm p-4 grid grid-cols-1 lg:grid-cols-[180px_1fr_auto] gap-3 items-start"
            >
              <div className="space-y-2">
                <Input
                  type="datetime-local"
                  step="1"
                  value={format(
                    new Date(node.occurredAt),
                    "yyyy-MM-dd'T'HH:mm:ss",
                  )}
                  onChange={(event) =>
                    updateNode(index, {
                      occurredAt: new Date(event.target.value).toISOString(),
                    })
                  }
                  className="font-mono text-xs rounded-sm"
                />
                <select
                  value={node.category}
                  onChange={(event) =>
                    updateNode(index, {
                      category: event.target
                        .value as BattleReviewManualNode["category"],
                    })
                  }
                  className="w-full h-9 rounded-sm border border-input bg-background px-3 font-mono text-xs"
                >
                  <option value="note">
                    {t("battleReplay.nodeCategories.note")}
                  </option>
                  <option value="phase">
                    {t("battleReplay.nodeCategories.phase")}
                  </option>
                  <option value="key_ship">
                    {t("battleReplay.nodeCategories.keyShip")}
                  </option>
                  <option value="key_kill">
                    {t("battleReplay.nodeCategories.keyKill")}
                  </option>
                  <option value="loss_peak">
                    {t("battleReplay.nodeCategories.lossPeak")}
                  </option>
                </select>
              </div>
              <div className="space-y-2">
                <Input
                  value={node.title}
                  maxLength={160}
                  placeholder={t("battleReplay.nodeTitle")}
                  onChange={(event) =>
                    updateNode(index, { title: event.target.value })
                  }
                  className="font-mono text-xs rounded-sm"
                />
                <Textarea
                  value={node.description}
                  maxLength={2000}
                  placeholder={t("battleReplay.nodeDescription")}
                  onChange={(event) =>
                    updateNode(index, { description: event.target.value })
                  }
                  className="min-h-20 text-sm rounded-sm"
                />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => {
                  setManualNodes((nodes) =>
                    nodes.filter((_, nodeIndex) => nodeIndex !== index),
                  );
                  setDirty(true);
                }}
              >
                <Trash2 className="w-4 h-4" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card className="bg-card/35 border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-3">
          <CardTitle className="font-mono text-sm uppercase">
            {t("battleReplay.fcConclusion")}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5 space-y-4">
          <Textarea
            value={conclusion}
            maxLength={10000}
            onChange={(event) => {
              setConclusion(event.target.value);
              setDirty(true);
            }}
            placeholder={t("battleReplay.conclusionPlaceholder")}
            className="min-h-40 rounded-sm leading-6"
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="outline"
              className="rounded-sm font-mono text-xs"
              onClick={() => save("draft")}
              disabled={update.isPending}
            >
              <Save className="w-4 h-4 mr-2" />
              {t("battleReplay.saveDraft")}
            </Button>
            <Button
              className="rounded-sm font-mono text-xs"
              onClick={() => save("published")}
              disabled={update.isPending}
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {t("battleReplay.publish")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AnalysisGroup({
  icon: Icon,
  title,
  items,
}: {
  icon: typeof Ship;
  title: string;
  items: {
    id: number;
    title: string;
    description: string;
    time: string;
    confidence: number;
    evidenceLevel?: "confirmed" | "inferred";
    evidence?: string;
  }[];
}) {
  const { t } = useTranslation();
  return (
    <Card className="bg-card/35 border-border/50 rounded-sm">
      <CardHeader className="border-b border-border/30 pb-3">
        <CardTitle className="font-mono text-sm uppercase flex items-center gap-2">
          <Icon className="w-4 h-4 text-primary" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-3">
        {items.length === 0 ? (
          <p className="font-mono text-xs text-muted-foreground">—</p>
        ) : (
          items.map((item) => (
            <div key={item.id} className="border-l-2 border-primary/40 pl-3">
              <div className="flex items-center justify-between gap-2">
                <p className="font-mono text-xs font-bold">{item.title}</p>
                <Badge
                  variant="outline"
                  className={
                    item.evidenceLevel === "inferred"
                      ? "shrink-0 rounded-sm border-amber-500/30 text-[9px] text-amber-400"
                      : "shrink-0 rounded-sm border-emerald-500/30 text-[9px] text-emerald-400"
                  }
                >
                  {item.evidenceLevel === "inferred"
                    ? t("battleReplay.inferred")
                    : t("battleReplay.confirmed")}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {item.description}
              </p>
              {item.evidence && (
                <p className="mt-2 text-[10px] text-emerald-400/75">
                  {t("battleReplay.evidence")}: {item.evidence}
                </p>
              )}
              <p className="font-mono text-[10px] text-primary mt-2">
                {format(new Date(item.time), "HH:mm:ss")} ·{" "}
                {t("battleReplay.confidence", {
                  value: Math.round(item.confidence * 100),
                })}
              </p>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
