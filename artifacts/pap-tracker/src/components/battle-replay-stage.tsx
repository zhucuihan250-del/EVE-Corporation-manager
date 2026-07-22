import { useMemo } from "react";
import { format } from "date-fns";
import {
  Crosshair,
  Eye,
  Film,
  Radar,
  ShieldCheck,
  Skull,
} from "lucide-react";
import type {
  BattleReportKillmail,
  BattleReportParticipant,
  BattleReplayPhase,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type ReplayMode = "cinematic" | "tactical";

type ObservedUnit = {
  key: string;
  characterId: number | null;
  characterName: string | null;
  shipTypeId: number | null;
  shipName: string | null;
};

function eventTime(event: BattleReportKillmail): number {
  return new Date(event.killmailTime).getTime();
}

function phasePriority(phase: BattleReplayPhase): number {
  return phase.kind === "turning_point"
    ? 5
    : phase.kind === "extraction"
      ? 4
      : phase.kind === "escalation"
        ? 3
        : phase.kind === "opening"
          ? 2
          : 1;
}

function unitImage(typeId: number | null | undefined): string | null {
  return typeId
    ? `https://images.evetech.net/types/${typeId}/icon?size=64`
    : null;
}

export function BattleReplayStage({
  events,
  currentIndex,
  participants,
  phases = [],
  startedAt,
  endedAt,
  mode,
  onModeChange,
  onJumpToKillmail,
}: {
  events: BattleReportKillmail[];
  currentIndex: number;
  participants: BattleReportParticipant[];
  phases?: BattleReplayPhase[];
  startedAt: string;
  endedAt: string;
  mode: ReplayMode;
  onModeChange: (mode: ReplayMode) => void;
  onJumpToKillmail: (killmailId: number) => void;
}) {
  const { t } = useTranslation();
  const activeEvent = events[currentIndex];
  const visibleEvents = events.slice(0, currentIndex + 1);
  const currentTime = activeEvent ? eventTime(activeEvent) : Date.now();

  const displayPhases = useMemo<BattleReplayPhase[]>(() => {
    if (phases.length > 0) return phases;
    if (events.length === 0) return [];
    const openingEndIndex = Math.min(
      events.length - 1,
      Math.max(0, Math.ceil(events.length * 0.25) - 1),
    );
    const opening = events.slice(0, openingEndIndex + 1);
    const later = events.slice(openingEndIndex + 1);
    const fallback: BattleReplayPhase[] = [
      {
        id: "client-contact",
        kind: "contact",
        startedAt,
        endedAt: events[0].killmailTime,
        title: t("battleReplay.phases.contact"),
        summary: t("battleReplay.phaseFallbackContact"),
        evidence: t("battleReplay.inferredFromFirstLoss"),
        evidenceLevel: "inferred",
        confidence: 0.5,
        relatedKillmailIds: [events[0].killmailId],
      },
      {
        id: "client-opening",
        kind: "opening",
        startedAt: opening[0].killmailTime,
        endedAt: opening.at(-1)!.killmailTime,
        title: t("battleReplay.phases.opening"),
        summary: t("battleReplay.phaseEventCount", { count: opening.length }),
        evidence: t("battleReplay.confirmedByKillmails", {
          count: opening.length,
        }),
        evidenceLevel: "confirmed",
        confidence: 0.9,
        relatedKillmailIds: opening.map((event) => event.killmailId),
      },
    ];
    if (later.length > 0) {
      fallback.push({
        id: "client-escalation",
        kind: "escalation",
        startedAt: later[0].killmailTime,
        endedAt: later.at(-1)!.killmailTime,
        title: t("battleReplay.phases.escalation"),
        summary: t("battleReplay.phaseEventCount", { count: later.length }),
        evidence: t("battleReplay.confirmedByKillmails", {
          count: later.length,
        }),
        evidenceLevel: "confirmed",
        confidence: 0.9,
        relatedKillmailIds: later.map((event) => event.killmailId),
      });
    }
    const last = events.at(-1)!;
    if (new Date(last.killmailTime).getTime() < new Date(endedAt).getTime()) {
      fallback.push({
        id: "client-extraction",
        kind: "extraction",
        startedAt: last.killmailTime,
        endedAt,
        title: t("battleReplay.phases.extraction"),
        summary: t("battleReplay.phaseFallbackExtraction"),
        evidence: t("battleReplay.inferredAfterLastLoss"),
        evidenceLevel: "inferred",
        confidence: 0.45,
        relatedKillmailIds: [last.killmailId],
      });
    }
    return fallback;
  }, [endedAt, events, phases, startedAt, t]);

  const activePhase = useMemo(() => {
    const containing = displayPhases
      .filter(
        (phase) =>
          new Date(phase.startedAt).getTime() <= currentTime &&
          new Date(phase.endedAt).getTime() >= currentTime,
      )
      .sort((left, right) => phasePriority(right) - phasePriority(left));
    if (containing[0]) return containing[0];
    return [...displayPhases]
      .filter((phase) => new Date(phase.startedAt).getTime() <= currentTime)
      .sort(
        (left, right) =>
          new Date(right.startedAt).getTime() -
          new Date(left.startedAt).getTime(),
      )[0];
  }, [currentTime, displayPhases]);

  const friendlyLossIds = new Set(
    visibleEvents
      .filter((event) => event.victimIsFleetMember)
      .flatMap((event) => event.victimCharacterId ?? []),
  );
  const hostileLosses = visibleEvents.filter(
    (event) => !event.victimIsFleetMember,
  );
  const friendlyLosses = visibleEvents.length - hostileLosses.length;

  const observedEnemies = useMemo(() => {
    const units = new Map<string, ObservedUnit>();
    for (const event of events.slice(0, currentIndex + 1)) {
      if (!event.victimIsFleetMember) {
        const key = event.victimCharacterId
          ? `character-${event.victimCharacterId}`
          : `victim-${event.killmailId}`;
        units.set(key, {
          key,
          characterId: event.victimCharacterId ?? null,
          characterName: event.victimCharacterName ?? null,
          shipTypeId: event.victimShipTypeId,
          shipName: event.victimShipName ?? null,
        });
      }
      for (const attacker of event.attackers ?? []) {
        if (attacker.isFleetMember) continue;
        const key = attacker.characterId
          ? `character-${attacker.characterId}`
          : `${attacker.shipTypeId ?? "unknown"}-${attacker.characterName ?? "unknown"}`;
        units.set(key, {
          key,
          characterId: attacker.characterId ?? null,
          characterName: attacker.characterName ?? null,
          shipTypeId: attacker.shipTypeId ?? null,
          shipName: attacker.shipName ?? null,
        });
      }
    }
    return [...units.values()].slice(0, mode === "cinematic" ? 10 : 18);
  }, [currentIndex, events, mode]);

  const hostileLostKeys = new Set(
    hostileLosses.map((event) =>
      event.victimCharacterId
        ? `character-${event.victimCharacterId}`
        : `victim-${event.killmailId}`,
    ),
  );

  if (!activeEvent) return null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Badge className="rounded-sm border-primary/30 bg-primary/10 text-primary">
            <Radar className="w-3 h-3 mr-1" />
            {activePhase?.title ?? t("battleReplay.liveReconstruction")}
          </Badge>
          <EvidenceBadge level={activePhase?.evidenceLevel ?? "confirmed"} />
        </div>
        <div className="flex gap-1">
          <Button
            type="button"
            size="sm"
            variant={mode === "cinematic" ? "default" : "outline"}
            className="h-8 rounded-sm font-mono text-[10px]"
            onClick={() => onModeChange("cinematic")}
          >
            <Film className="w-3 h-3 mr-1" />
            {t("battleReplay.cinematicMode")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={mode === "tactical" ? "default" : "outline"}
            className="h-8 rounded-sm font-mono text-[10px]"
            onClick={() => onModeChange("tactical")}
          >
            <Crosshair className="w-3 h-3 mr-1" />
            {t("battleReplay.tacticalMode")}
          </Button>
        </div>
      </div>

      <div className="relative min-h-[360px] overflow-hidden rounded-sm border border-primary/25 bg-[#030913]">
        <div className="absolute inset-0 opacity-50 [background-image:linear-gradient(rgba(251,191,36,0.06)_1px,transparent_1px),linear-gradient(90deg,rgba(251,191,36,0.06)_1px,transparent_1px)] [background-size:32px_32px]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(245,158,11,0.12),transparent_42%)]" />
        <div className="relative z-10 grid min-h-[360px] grid-cols-[1fr_72px_1fr] sm:grid-cols-[1fr_96px_1fr] lg:grid-cols-[1fr_112px_1fr]">
          <FleetColumn
            side="friendly"
            units={participants
              .slice(0, mode === "cinematic" ? 10 : 18)
              .map((participant) => ({
                key: `character-${participant.eveCharacterId}`,
                characterId: participant.eveCharacterId,
                characterName: participant.characterName,
                shipTypeId: participant.primaryShipTypeId ?? null,
                shipName: participant.primaryShipName ?? null,
              }))}
            lostKeys={new Set(
              [...friendlyLossIds].map((id) => `character-${id}`),
            )}
            title={t("battleReplay.friendlyFormation")}
          />

          <div className="relative flex flex-col items-center justify-center border-x border-primary/10 px-2">
            <div
              className={`absolute top-1/2 h-px w-[210%] -translate-y-1/2 ${activeEvent.victimIsFleetMember ? "bg-gradient-to-r from-red-500/80 via-red-300/60 to-transparent" : "bg-gradient-to-l from-emerald-500/80 via-emerald-300/60 to-transparent"} animate-pulse`}
            />
            <div className="relative z-10 rounded-full border border-primary/50 bg-background/85 p-2 shadow-[0_0_32px_rgba(245,158,11,0.32)]">
              <img
                src={`https://images.evetech.net/types/${activeEvent.victimShipTypeId}/icon?size=128`}
                alt=""
                className="h-16 w-16 rounded-full"
              />
              <span className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full border border-red-400/60 bg-red-950 text-red-300">
                <Skull className="h-3 w-3" />
              </span>
            </div>
            <p className="relative z-10 mt-3 max-w-24 truncate text-center font-mono text-[10px] font-bold text-primary">
              {activeEvent.victimShipName ?? t("battleReplay.unknownShip")}
            </p>
            <p className="relative z-10 mt-1 text-center font-mono text-[9px] text-muted-foreground">
              {format(new Date(activeEvent.killmailTime), "HH:mm:ss")}
            </p>
          </div>

          <FleetColumn
            side="hostile"
            units={observedEnemies}
            lostKeys={hostileLostKeys}
            title={t("battleReplay.hostileFormation")}
          />
        </div>

        <div className="absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-3 rounded-sm border border-border/30 bg-background/85 px-4 py-2 backdrop-blur">
          <span className="font-mono text-[10px] text-red-400">
            {t("battleReplay.friendlyLossCount", { count: friendlyLosses })}
          </span>
          <span className="h-3 w-px bg-border" />
          <span className="font-mono text-[10px] text-emerald-400">
            {t("battleReplay.hostileLossCount", {
              count: hostileLosses.length,
            })}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
        {displayPhases.slice(0, 5).map((phase) => (
          <button
            key={phase.id}
            type="button"
            className={`rounded-sm border p-2 text-left transition-colors ${activePhase?.id === phase.id ? "border-primary/60 bg-primary/10" : "border-border/40 bg-card/25 hover:border-primary/30"}`}
            onClick={() => {
              const killmailId = phase.relatedKillmailIds[0];
              if (killmailId) onJumpToKillmail(killmailId);
            }}
          >
            <div className="flex items-center justify-between gap-1">
              <span className="truncate font-mono text-[10px] font-bold">
                {phase.title}
              </span>
              <EvidenceIcon level={phase.evidenceLevel} />
            </div>
            <p className="mt-1 font-mono text-[9px] text-muted-foreground">
              {format(new Date(phase.startedAt), "HH:mm:ss")}
            </p>
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-4 border border-border/35 bg-card/20 px-3 py-2 font-mono text-[9px] text-muted-foreground">
        <span className="inline-flex items-center gap-1 text-emerald-400">
          <ShieldCheck className="h-3 w-3" />
          {t("battleReplay.confirmedEvidence")}
        </span>
        <span className="inline-flex items-center gap-1 text-amber-400">
          <Eye className="h-3 w-3" />
          {t("battleReplay.inferredEvidence")}
        </span>
        <span>{t("battleReplay.reconstructionDisclaimer")}</span>
      </div>
    </div>
  );
}

function FleetColumn({
  side,
  units,
  lostKeys,
  title,
}: {
  side: "friendly" | "hostile";
  units: ObservedUnit[];
  lostKeys: Set<string>;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="p-2 sm:p-3">
      <div
        className={`mb-3 flex items-center gap-2 font-mono text-[10px] font-bold uppercase ${side === "friendly" ? "text-primary" : "justify-end text-red-400"}`}
      >
        {side === "friendly" && <ShieldCheck className="h-3 w-3" />}
        {title}
        {side === "hostile" && <Crosshair className="h-3 w-3" />}
      </div>
      <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
        {units.map((unit) => {
          const image = unitImage(unit.shipTypeId);
          const lost = lostKeys.has(unit.key);
          return (
            <div
              key={unit.key}
              className={`relative min-w-0 rounded-sm border p-2 text-center transition-all ${lost ? "border-red-500/30 bg-red-950/30 opacity-45 grayscale" : side === "friendly" ? "border-primary/25 bg-primary/5" : "border-red-500/20 bg-red-500/5"}`}
            >
              {image ? (
                <img
                  src={image}
                  alt=""
                  className={`mx-auto h-9 w-9 rounded-full ${lost ? "animate-none" : "motion-safe:animate-[pulse_3s_ease-in-out_infinite]"}`}
                />
              ) : (
                <div className="mx-auto h-9 w-9 rounded-full border border-border/40 bg-muted/20" />
              )}
              <p className="mt-1 truncate font-mono text-[9px] font-bold">
                {unit.shipName ?? t("battleReplay.unknownShip")}
              </p>
              <p className="truncate font-mono text-[8px] text-muted-foreground">
                {unit.characterName ?? t("battleReplay.unknownPilot")}
              </p>
              {lost && (
                <Skull className="absolute right-1 top-1 h-3 w-3 text-red-400" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function EvidenceBadge({ level }: { level: "confirmed" | "inferred" }) {
  const { t } = useTranslation();
  return (
    <Badge
      variant="outline"
      className={
        level === "confirmed"
          ? "rounded-sm border-emerald-500/30 text-emerald-400"
          : "rounded-sm border-amber-500/30 text-amber-400"
      }
    >
      {level === "confirmed"
        ? t("battleReplay.confirmed")
        : t("battleReplay.inferred")}
    </Badge>
  );
}

function EvidenceIcon({ level }: { level: "confirmed" | "inferred" }) {
  return level === "confirmed" ? (
    <ShieldCheck className="h-3 w-3 shrink-0 text-emerald-400" />
  ) : (
    <Eye className="h-3 w-3 shrink-0 text-amber-400" />
  );
}
