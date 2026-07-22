import { useEffect, useMemo, useState } from "react";
import { format } from "date-fns";
import {
  ExternalLink,
  Pause,
  Play,
  RotateCcw,
  SkipBack,
  SkipForward,
} from "lucide-react";
import type {
  BattleReportKillmail,
  BattleReplayAnalysis,
  BattleReviewManualNode,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";

function formatIsk(value: number): string {
  if (value >= 1_000_000_000_000)
    return `${(value / 1_000_000_000_000).toFixed(2)}t`;
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}b`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return Math.round(value).toLocaleString();
}

export function BattleReplayPlayer({
  killmails,
  analysis,
  manualNodes = [],
  onEventChange,
}: {
  killmails: BattleReportKillmail[];
  analysis?: BattleReplayAnalysis | null;
  manualNodes?: BattleReviewManualNode[];
  onEventChange?: (occurredAt: string) => void;
}) {
  const { t } = useTranslation();
  const [eventFilter, setEventFilter] = useState<"all" | "fleet" | "enemy">(
    "all",
  );
  const allEvents = useMemo(
    () =>
      [...killmails].sort(
        (left, right) =>
          new Date(left.killmailTime).getTime() -
          new Date(right.killmailTime).getTime(),
      ),
    [killmails],
  );
  const events = useMemo(
    () =>
      allEvents.filter((event) => {
        if (eventFilter === "fleet") return !event.victimIsFleetMember;
        if (eventFilter === "enemy") return event.victimIsFleetMember;
        return true;
      }),
    [allEvents, eventFilter],
  );
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const activeEvent = events[currentIndex];
  const relevantAttackers = useMemo(
    () =>
      [...(activeEvent?.attackers ?? [])]
        .filter((attacker) =>
          activeEvent?.victimIsFleetMember
            ? !attacker.isFleetMember
            : attacker.isFleetMember,
        )
        .sort(
          (left, right) =>
            Number(right.finalBlow) - Number(left.finalBlow) ||
            right.damageDone - left.damageDone,
        ),
    [activeEvent],
  );

  const markers = useMemo(() => {
    const result = new Map<number, string[]>();
    for (const event of analysis?.keyShips ?? [])
      result.set(event.killmailId, [
        ...(result.get(event.killmailId) ?? []),
        t("battleReplay.keyShip"),
      ]);
    for (const event of analysis?.keyKills ?? [])
      result.set(event.killmailId, [
        ...(result.get(event.killmailId) ?? []),
        t("battleReplay.keyKill"),
      ]);
    for (const peak of analysis?.lossPeaks ?? []) {
      for (const id of peak.killmailIds)
        result.set(id, [...(result.get(id) ?? []), t("battleReplay.lossPeak")]);
    }
    return result;
  }, [analysis, t]);

  useEffect(() => {
    if (events.length === 0) {
      setCurrentIndex(0);
      setIsPlaying(false);
      return;
    }
    setCurrentIndex((index) => Math.min(index, events.length - 1));
  }, [events.length]);

  useEffect(() => {
    if (!isPlaying || events.length < 2) return;
    const timer = window.setInterval(
      () => {
        setCurrentIndex((index) => {
          if (index >= events.length - 1) {
            setIsPlaying(false);
            return index;
          }
          return index + 1;
        });
      },
      Math.max(250, 1_200 / speed),
    );
    return () => window.clearInterval(timer);
  }, [events.length, isPlaying, speed]);

  useEffect(() => {
    if (activeEvent) onEventChange?.(activeEvent.killmailTime);
  }, [activeEvent, onEventChange]);

  if (!activeEvent) {
    return (
      <div className="space-y-4">
        {allEvents.length > 0 && (
          <EventFilters
            value={eventFilter}
            onChange={(value) => {
              setEventFilter(value);
              setCurrentIndex(0);
              setIsPlaying(false);
            }}
            t={t}
          />
        )}
        <div className="p-10 text-center font-mono text-sm text-muted-foreground">
          {t(
            allEvents.length === 0
              ? "battleReports.noKillmails"
              : "battleReplay.noFilteredEvents",
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <EventFilters
        value={eventFilter}
        onChange={(value) => {
          setEventFilter(value);
          setCurrentIndex(0);
          setIsPlaying(false);
        }}
        t={t}
      />

      <Card
        className={`rounded-sm overflow-hidden ${activeEvent.victimIsFleetMember ? "border-red-500/30 bg-red-500/5" : "border-emerald-500/30 bg-emerald-500/5"}`}
      >
        <CardContent className="p-5">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-5">
            <div className="flex items-center gap-4 min-w-0">
              <img
                src={`https://images.evetech.net/types/${activeEvent.victimShipTypeId}/icon?size=128`}
                alt=""
                className="w-16 h-16 shrink-0"
              />
              <div className="min-w-0">
                <div className="flex flex-wrap gap-2 mb-2">
                  <Badge
                    variant="outline"
                    className={
                      activeEvent.victimIsFleetMember
                        ? "border-red-500/40 text-red-400"
                        : "border-emerald-500/40 text-emerald-400"
                    }
                  >
                    {activeEvent.victimIsFleetMember
                      ? t("battleReplay.friendlyLoss")
                      : t("battleReplay.hostileLoss")}
                  </Badge>
                  {(markers.get(activeEvent.killmailId) ?? []).map((marker) => (
                    <Badge
                      key={marker}
                      className="bg-primary/15 text-primary border-primary/30"
                    >
                      {marker}
                    </Badge>
                  ))}
                </div>
                <h3 className="font-mono font-bold text-lg truncate">
                  {activeEvent.victimShipName ||
                    `Type ${activeEvent.victimShipTypeId}`}
                </h3>
                <p className="font-mono text-xs text-muted-foreground truncate">
                  {activeEvent.victimCharacterName ||
                    t("battleReports.unknownVictim")}{" "}
                  · {activeEvent.solarSystemName || activeEvent.solarSystemId}
                </p>
              </div>
            </div>
            <div className="md:text-right shrink-0">
              <p className="font-mono text-2xl font-bold">
                {formatIsk(activeEvent.totalValue)} ISK
              </p>
              <p className="font-mono text-xs text-muted-foreground mt-1">
                {format(
                  new Date(activeEvent.killmailTime),
                  "yyyy-MM-dd HH:mm:ss",
                )}
              </p>
              {activeEvent.zkillboardUrl && (
                <a
                  href={activeEvent.zkillboardUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mt-2 font-mono text-xs text-primary hover:underline"
                >
                  zKillboard <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>

          <div className="mt-5 border-t border-border/30 pt-4">
            <div className="flex items-center justify-between gap-3 mb-3">
              <p className="font-mono text-xs font-bold uppercase tracking-wider">
                {activeEvent.victimIsFleetMember
                  ? t("battleReplay.enemyAttackers")
                  : t("battleReplay.fleetAttackers")}
              </p>
              <span className="font-mono text-[10px] text-muted-foreground">
                {t("battleReplay.attackersObserved", {
                  count: relevantAttackers.length,
                })}
              </span>
            </div>
            {relevantAttackers.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground">
                {t("battleReplay.noAttackerData")}
              </p>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {relevantAttackers.slice(0, 8).map((attacker, index) => (
                  <div
                    key={`${attacker.characterId ?? "npc"}-${attacker.shipTypeId ?? "ship"}-${index}`}
                    className="flex items-center gap-3 border border-border/35 bg-background/35 rounded-sm p-2.5"
                  >
                    {attacker.shipTypeId ? (
                      <img
                        src={`https://images.evetech.net/types/${attacker.shipTypeId}/icon?size=64`}
                        alt=""
                        className="w-9 h-9 shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 shrink-0 border border-border/40 bg-muted/20" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs font-bold truncate">
                          {attacker.shipName || t("battleReplay.unknownShip")}
                        </span>
                        {attacker.finalBlow && (
                          <Badge className="shrink-0 bg-red-500/15 border-red-500/30 text-red-400 text-[9px] px-1.5 py-0">
                            {t("battleReplay.finalBlow")}
                          </Badge>
                        )}
                      </div>
                      <p className="font-mono text-[10px] text-muted-foreground truncate mt-0.5">
                        {attacker.characterName ||
                          t("battleReplay.unknownPilot")}
                        {attacker.corporationName
                          ? ` · ${attacker.corporationName}`
                          : ""}
                      </p>
                    </div>
                    <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                      {formatIsk(attacker.damageDone)} DMG
                    </span>
                  </div>
                ))}
              </div>
            )}
            {relevantAttackers.length > 8 && (
              <p className="font-mono text-[10px] text-muted-foreground mt-2 text-right">
                {t("battleReplay.moreAttackers", {
                  count: relevantAttackers.length - 8,
                })}
              </p>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="border border-border/50 bg-card/35 rounded-sm p-4 space-y-4">
        <Slider
          value={[currentIndex]}
          min={0}
          max={Math.max(0, events.length - 1)}
          step={1}
          onValueChange={([value]) => {
            setCurrentIndex(value);
            setIsPlaying(false);
          }}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="icon"
              className="rounded-sm"
              onClick={() => {
                setCurrentIndex(0);
                setIsPlaying(false);
              }}
              aria-label={t("battleReplay.restart")}
            >
              <RotateCcw className="w-4 h-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="rounded-sm"
              onClick={() => {
                setCurrentIndex((index) => Math.max(0, index - 1));
                setIsPlaying(false);
              }}
              aria-label={t("battleReplay.previous")}
            >
              <SkipBack className="w-4 h-4" />
            </Button>
            <Button
              className="rounded-sm min-w-24"
              onClick={() => setIsPlaying((playing) => !playing)}
              disabled={events.length < 2}
            >
              {isPlaying ? (
                <Pause className="w-4 h-4 mr-2" />
              ) : (
                <Play className="w-4 h-4 mr-2" />
              )}
              {isPlaying ? t("battleReplay.pause") : t("battleReplay.play")}
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="rounded-sm"
              onClick={() => {
                setCurrentIndex((index) =>
                  Math.min(events.length - 1, index + 1),
                );
                setIsPlaying(false);
              }}
              aria-label={t("battleReplay.next")}
            >
              <SkipForward className="w-4 h-4" />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {currentIndex + 1} / {events.length}
            </span>
            {[0.5, 1, 2, 4].map((value) => (
              <Button
                key={value}
                variant={speed === value ? "default" : "outline"}
                size="sm"
                className="rounded-sm h-8 px-2 font-mono text-xs"
                onClick={() => setSpeed(value)}
              >
                {value}×
              </Button>
            ))}
          </div>
        </div>
      </div>

      {(manualNodes.length > 0 || markers.size > 0) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {manualNodes
            .filter(
              (node) =>
                Math.abs(
                  new Date(node.occurredAt).getTime() -
                    new Date(activeEvent.killmailTime).getTime(),
                ) <= 60_000,
            )
            .map((node) => (
              <div
                key={node.id}
                className="border border-primary/25 bg-primary/5 rounded-sm p-3"
              >
                <p className="font-mono text-xs font-bold text-primary">
                  {node.title}
                </p>
                <p className="font-mono text-xs text-muted-foreground mt-1 whitespace-pre-wrap">
                  {node.description}
                </p>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function EventFilters({
  value,
  onChange,
  t,
}: {
  value: "all" | "fleet" | "enemy";
  onChange: (value: "all" | "fleet" | "enemy") => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {(["all", "fleet", "enemy"] as const).map((filter) => (
        <Button
          key={filter}
          type="button"
          variant={value === filter ? "default" : "outline"}
          size="sm"
          className="rounded-sm font-mono text-xs"
          onClick={() => onChange(filter)}
        >
          {t(`battleReplay.eventFilter.${filter}`)}
        </Button>
      ))}
    </div>
  );
}
