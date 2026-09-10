import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  SystemIntelEvent,
  SystemMonitorSummary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Crosshair, LocateFixed, Network, ZoomIn, ZoomOut } from "lucide-react";
import { layoutMapLabels } from "./system-intel-map-layout";

const CANVAS_WIDTH = 1_000;
const CANVAS_HEIGHT = 560;
const MIN_VIEW_WIDTH = 280;
const MAX_VIEW_WIDTH = 2_000;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const RISK_RANK: Record<string, number> = {
  safe: 0,
  info: 1,
  warning: 2,
  danger: 3,
  critical: 4,
};

const RISK_COLORS: Record<string, string> = {
  safe: "#34d399",
  info: "#38bdf8",
  warning: "#fbbf24",
  danger: "#fb923c",
  critical: "#fb7185",
};

type Coordinate = {
  x: number;
  y: number;
};

type MapNode = {
  solarSystemId: number;
  solarSystemName: string;
  rawPosition: Coordinate | null;
  position: Coordinate;
  monitor: SystemMonitorSummary | null;
  activeEvents: SystemIntelEvent[];
};

type MapEdge = {
  from: number;
  to: number;
};

type ParsedMapPayload = {
  nodes: Array<{
    solarSystemId: number;
    solarSystemName: string;
    position: Coordinate | null;
    connections: number[];
  }>;
  edges: MapEdge[];
};

type ViewBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type SystemIntelMapProps = {
  monitors: SystemMonitorSummary[];
  events: SystemIntelEvent[];
  dashboardData?: unknown;
  zh: boolean;
  onSelectMonitor?: (monitorId: number) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: string[],
): number | null {
  for (const key of keys) {
    const value = finiteNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function systemIdFrom(value: unknown): number | null {
  if (typeof value === "number" || typeof value === "string") {
    return finiteNumber(value);
  }
  if (!isRecord(value)) return null;
  return firstNumber(value, [
    "solarSystemId",
    "systemId",
    "id",
    "destinationSystemId",
  ]);
}

function projectedPosition(value: unknown): Coordinate | null {
  if (!isRecord(value)) return null;

  for (const key of ["mapPosition", "position2D"]) {
    if (!isRecord(value[key])) continue;
    const x = firstNumber(value[key], ["x", "mapX"]);
    const y = firstNumber(value[key], ["y", "mapY"]);
    if (x !== null && y !== null) return { x, y };
  }

  const mapX = firstNumber(value, ["mapX", "coordinateX", "projectedX"]);
  const mapY = firstNumber(value, ["mapY", "coordinateY", "projectedY"]);
  if (mapX !== null && mapY !== null) return { x: mapX, y: mapY };

  for (const key of ["position", "coordinates", "coordinate"]) {
    if (!isRecord(value[key])) continue;
    const nested = value[key];
    const x = firstNumber(nested, ["x", "mapX", "coordinateX"]);
    const z = firstNumber(nested, ["z", "mapZ", "coordinateZ"]);
    const y = firstNumber(nested, ["y", "mapY", "coordinateY"]);
    if (x !== null && (z ?? y) !== null) return { x, y: z ?? y ?? 0 };
  }

  const x = firstNumber(value, ["x"]);
  const z = firstNumber(value, ["z"]);
  const y = firstNumber(value, ["y"]);
  return x !== null && (z ?? y) !== null ? { x, y: z ?? y ?? 0 } : null;
}

function connectionIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const id = systemIdFrom(item);
    return id === null ? [] : [id];
  });
}

function parseNode(value: unknown): ParsedMapPayload["nodes"][number] | null {
  if (!isRecord(value)) return null;
  const solarSystemId = systemIdFrom(value);
  if (solarSystemId === null) return null;
  const solarSystemName =
    [value.solarSystemName, value.systemName, value.name].find(
      (candidate): candidate is string =>
        typeof candidate === "string" && candidate.length > 0,
    ) ?? String(solarSystemId);
  return {
    solarSystemId,
    solarSystemName,
    position: projectedPosition(value),
    connections: [
      ...connectionIds(value.connections),
      ...connectionIds(value.neighbors),
      ...connectionIds(value.gates),
    ],
  };
}

function parseEdge(value: unknown): MapEdge | null {
  if (Array.isArray(value) && value.length >= 2) {
    const from = systemIdFrom(value[0]);
    const to = systemIdFrom(value[1]);
    return from === null || to === null ? null : { from, to };
  }
  if (!isRecord(value)) return null;
  const from = systemIdFrom(
    value.from ?? value.source ?? value.fromSolarSystemId ?? value.origin,
  );
  const to = systemIdFrom(
    value.to ?? value.target ?? value.toSolarSystemId ?? value.destination,
  );
  return from === null || to === null ? null : { from, to };
}

function firstArray(
  record: Record<string, unknown>,
  keys: string[],
): unknown[] {
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

function parseMapPayload(dashboardData: unknown): ParsedMapPayload {
  if (!isRecord(dashboardData)) return { nodes: [], edges: [] };
  const nestedMap = [
    dashboardData.map,
    dashboardData.starMap,
    dashboardData.mapData,
  ].find(isRecord);
  const mapRecord = nestedMap ?? dashboardData;
  const rawNodes = firstArray(mapRecord, [
    "nodes",
    "systems",
    "solarSystems",
    "mapNodes",
  ]);
  const rawEdges = firstArray(mapRecord, [
    "edges",
    "connections",
    "jumps",
    "stargates",
    "mapEdges",
  ]);
  const nodes = rawNodes.flatMap((value) => {
    const node = parseNode(value);
    return node ? [node] : [];
  });
  const explicitEdges = rawEdges.flatMap((value) => {
    const edge = parseEdge(value);
    return edge ? [edge] : [];
  });
  const nodeEdges = nodes.flatMap((node) =>
    node.connections.map((to) => ({ from: node.solarSystemId, to })),
  );
  return { nodes, edges: [...explicitEdges, ...nodeEdges] };
}

function fallbackPosition(index: number, total: number): Coordinate {
  if (total <= 1) return { x: CANVAS_WIDTH / 2, y: CANVAS_HEIGHT / 2 };
  const radius = Math.min(210, 50 + Math.sqrt(index + 1) * 48);
  const angle = index * GOLDEN_ANGLE - Math.PI / 2;
  return {
    x: CANVAS_WIDTH / 2 + Math.cos(angle) * radius,
    y: CANVAS_HEIGHT / 2 + Math.sin(angle) * radius * 0.72,
  };
}

function normalizePositions(
  nodes: Array<Omit<MapNode, "position">>,
): MapNode[] {
  const positioned = nodes.filter(
    (node): node is Omit<MapNode, "position"> & { rawPosition: Coordinate } =>
      node.rawPosition !== null,
  );
  if (!positioned.length) {
    return nodes.map((node, index) => ({
      ...node,
      position: fallbackPosition(index, nodes.length),
    }));
  }

  const xValues = positioned.map((node) => node.rawPosition.x);
  const yValues = positioned.map((node) => node.rawPosition.y);
  const minX = Math.min(...xValues);
  const maxX = Math.max(...xValues);
  const minY = Math.min(...yValues);
  const maxY = Math.max(...yValues);
  const xRange = maxX - minX;
  const yRange = maxY - minY;
  const paddingX = 90;
  const paddingY = 70;
  const availableWidth = CANVAS_WIDTH - paddingX * 2;
  const availableHeight = CANVAS_HEIGHT - paddingY * 2;
  const fittedScale = Math.min(
    xRange > 0 ? availableWidth / xRange : Number.POSITIVE_INFINITY,
    yRange > 0 ? availableHeight / yRange : Number.POSITIVE_INFINITY,
  );
  const scale = Number.isFinite(fittedScale) ? fittedScale : 1;
  const renderedWidth = xRange * scale;
  const renderedHeight = yRange * scale;
  const offsetX = paddingX + (availableWidth - renderedWidth) / 2;
  const offsetY = paddingY + (availableHeight - renderedHeight) / 2;

  let missingIndex = 0;
  return nodes.map((node) => {
    if (!node.rawPosition) {
      const fallback = fallbackPosition(missingIndex, nodes.length);
      missingIndex += 1;
      return { ...node, position: fallback };
    }
    return {
      ...node,
      position: {
        x:
          xRange === 0
            ? CANVAS_WIDTH / 2
            : offsetX + (node.rawPosition.x - minX) * scale,
        y:
          yRange === 0
            ? CANVAS_HEIGHT / 2
            : offsetY + (maxY - node.rawPosition.y) * scale,
      },
    };
  });
}

function buildMap(
  monitors: SystemMonitorSummary[],
  events: SystemIntelEvent[],
  dashboardData: unknown,
): { nodes: MapNode[]; edges: MapEdge[]; coordinateCount: number } {
  const payload = parseMapPayload(dashboardData);
  const monitorBySystemId = new Map(
    monitors.map((monitor) => [monitor.solarSystemId, monitor]),
  );
  const payloadBySystemId = new Map(
    payload.nodes.map((node) => [node.solarSystemId, node]),
  );
  const now = Date.now();
  const activeEventsBySystemId = new Map<number, SystemIntelEvent[]>();
  for (const event of events) {
    if (event.expiresAt && new Date(event.expiresAt).getTime() <= now) continue;
    const current = activeEventsBySystemId.get(event.solarSystemId) ?? [];
    current.push(event);
    activeEventsBySystemId.set(event.solarSystemId, current);
  }

  const systemIds = new Set([
    ...monitorBySystemId.keys(),
    ...payloadBySystemId.keys(),
  ]);
  const unpositionedNodes: Array<Omit<MapNode, "position">> = [];
  for (const solarSystemId of systemIds) {
    const monitor = monitorBySystemId.get(solarSystemId) ?? null;
    const payloadNode = payloadBySystemId.get(solarSystemId);
    unpositionedNodes.push({
      solarSystemId,
      solarSystemName:
        payloadNode?.solarSystemName ??
        monitor?.solarSystemName ??
        String(solarSystemId),
      rawPosition:
        payloadNode?.position ?? (monitor ? projectedPosition(monitor) : null),
      monitor,
      activeEvents: activeEventsBySystemId.get(solarSystemId) ?? [],
    });
  }
  unpositionedNodes.sort((left, right) => {
    const monitorRank =
      Number(Boolean(right.monitor)) - Number(Boolean(left.monitor));
    return (
      monitorRank ||
      left.solarSystemName.localeCompare(right.solarSystemName, undefined, {
        numeric: true,
      })
    );
  });
  const nodes = normalizePositions(unpositionedNodes);
  const visibleIds = new Set(nodes.map((node) => node.solarSystemId));
  const edgeKeys = new Set<string>();
  const edges = payload.edges.filter((edge) => {
    if (
      edge.from === edge.to ||
      !visibleIds.has(edge.from) ||
      !visibleIds.has(edge.to)
    ) {
      return false;
    }
    const key = [edge.from, edge.to].sort((a, b) => a - b).join(":");
    if (edgeKeys.has(key)) return false;
    edgeKeys.add(key);
    return true;
  });
  return {
    nodes,
    edges,
    coordinateCount: nodes.filter((node) => node.rawPosition !== null).length,
  };
}

function zoomedView(view: ViewBox, factor: number): ViewBox {
  const width = Math.min(
    MAX_VIEW_WIDTH,
    Math.max(MIN_VIEW_WIDTH, view.width * factor),
  );
  const height = width * (CANVAS_HEIGHT / CANVAS_WIDTH);
  return {
    x: view.x + (view.width - width) / 2,
    y: view.y + (view.height - height) / 2,
    width,
    height,
  };
}

function remainingMinutes(event: SystemIntelEvent): number | null {
  if (!event.expiresAt) return null;
  return Math.max(
    0,
    Math.ceil((new Date(event.expiresAt).getTime() - Date.now()) / 60_000),
  );
}

function eventPeopleCount(event: SystemIntelEvent): number {
  const participantCount = isRecord(event.metadata)
    ? finiteNumber(event.metadata.playerParticipantCount)
    : null;
  return Math.max(0, participantCount ?? event.enemyCount ?? 0);
}

function nodePeopleCount(node: MapNode): number {
  return Math.max(0, ...node.activeEvents.map(eventPeopleCount));
}

function nodeActivityRadius(node: MapNode): number {
  const intensity =
    (node.monitor?.recentKillCount ?? 0) +
    node.activeEvents.length +
    Math.sqrt(nodePeopleCount(node));
  return Math.min(15, 6 + intensity * 0.9);
}

function nodeCircleRadius(node: MapNode): number {
  return node.monitor ? nodeActivityRadius(node) : 3.25;
}

function nodeVisualRadius(node: MapNode, selected: boolean): number {
  const activityRadius = nodeActivityRadius(node);
  return Math.max(
    nodeCircleRadius(node),
    node.activeEvents.length > 0 ? activityRadius + 11 : 0,
    selected ? activityRadius + 7 : 0,
  );
}

function localizedRisk(risk: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    safe: ["安全", "SAFE"],
    info: ["有活动", "ACTIVITY"],
    warning: ["注意", "CAUTION"],
    danger: ["危险", "DANGER"],
    critical: ["严重", "CRITICAL"],
  };
  return labels[risk]?.[zh ? 0 : 1] ?? risk;
}

export function SystemIntelMap({
  monitors,
  events,
  dashboardData,
  zh,
  onSelectMonitor,
}: SystemIntelMapProps) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const map = useMemo(
    () => buildMap(monitors, events, dashboardData),
    [dashboardData, events, monitors],
  );
  const [view, setView] = useState<ViewBox>({
    x: 0,
    y: 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });
  const [selectedSystemId, setSelectedSystemId] = useState<number | null>(null);
  const [hoveredSystemId, setHoveredSystemId] = useState<number | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    view: ViewBox;
  } | null>(null);
  const hoverClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hoverClearTimerRef.current) {
        clearTimeout(hoverClearTimerRef.current);
      }
    },
    [],
  );
  const nodeById = useMemo(
    () => new Map(map.nodes.map((node) => [node.solarSystemId, node])),
    [map.nodes],
  );
  const selectedNode =
    (selectedSystemId === null ? null : nodeById.get(selectedSystemId)) ??
    map.nodes.find((node) => node.monitor) ??
    map.nodes[0];
  const labelPlacements = useMemo(
    () =>
      layoutMapLabels(
        map.nodes.map((node) => {
          const peopleCount = nodePeopleCount(node);
          const snapshotParts: string[] = [];
          if (
            node.monitor &&
            (node.monitor.recentKillCount > 0 ||
              node.monitor.activeEventCount > 0)
          ) {
            snapshotParts.push(
              `K${node.monitor.recentKillCount} · A${node.monitor.activeEventCount}`,
            );
          }
          if (peopleCount > 0) {
            snapshotParts.push(`${zh ? "人数" : "People"} ${peopleCount}`);
          }
          return {
            id: node.solarSystemId,
            name: node.solarSystemName,
            position: node.position,
            radius: nodeVisualRadius(
              node,
              node.solarSystemId === selectedSystemId,
            ),
            isMonitored: Boolean(node.monitor),
            hasActiveAlert: node.activeEvents.length > 0,
            isContextVisible:
              node.solarSystemId === selectedSystemId ||
              node.solarSystemId === hoveredSystemId,
            detail: snapshotParts.join(" · ") || null,
          };
        }),
        {
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          scale: view.width / CANVAS_WIDTH,
        },
      ),
    [hoveredSystemId, map.nodes, selectedSystemId, view.width, zh],
  );
  const coordinateMode =
    map.coordinateCount === map.nodes.length
      ? "actual"
      : map.coordinateCount > 0
        ? "partial"
        : "fallback";

  const startNodeHover = (solarSystemId: number) => {
    if (hoverClearTimerRef.current) {
      clearTimeout(hoverClearTimerRef.current);
      hoverClearTimerRef.current = null;
    }
    setHoveredSystemId(solarSystemId);
  };

  const endNodeHover = (solarSystemId: number) => {
    if (hoverClearTimerRef.current) {
      clearTimeout(hoverClearTimerRef.current);
    }
    hoverClearTimerRef.current = setTimeout(() => {
      setHoveredSystemId((current) =>
        current === solarSystemId ? null : current,
      );
      hoverClearTimerRef.current = null;
    }, 160);
  };

  const selectNode = (node: MapNode) => {
    setSelectedSystemId(node.solarSystemId);
    if (node.monitor) onSelectMonitor?.(node.monitor.id);
  };

  const handleNodeKeyDown = (
    event: ReactKeyboardEvent<SVGGElement>,
    node: MapNode,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectNode(node);
  };

  const resetView = () =>
    setView({ x: 0, y: 0, width: CANVAS_WIDTH, height: CANVAS_HEIGHT });

  const handleWheel = (event: ReactWheelEvent<SVGSVGElement>) => {
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const cursorX =
      view.x + ((event.clientX - rect.left) / rect.width) * view.width;
    const cursorY =
      view.y + ((event.clientY - rect.top) / rect.height) * view.height;
    const factor = event.deltaY > 0 ? 1.15 : 0.86;
    const nextWidth = Math.min(
      MAX_VIEW_WIDTH,
      Math.max(MIN_VIEW_WIDTH, view.width * factor),
    );
    const nextHeight = nextWidth * (CANVAS_HEIGHT / CANVAS_WIDTH);
    const xRatio = (cursorX - view.x) / view.width;
    const yRatio = (cursorY - view.y) / view.height;
    setView({
      x: cursorX - xRatio * nextWidth,
      y: cursorY - yRatio * nextHeight,
      width: nextWidth,
      height: nextHeight,
    });
  };

  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      view,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setView({
      ...drag.view,
      x:
        drag.view.x -
        ((event.clientX - drag.clientX) / rect.width) * drag.view.width,
      y:
        drag.view.y -
        ((event.clientY - drag.clientY) / rect.height) * drag.view.height,
    });
  };

  const stopDragging = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 px-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {Object.entries(RISK_COLORS).map(([risk, color]) => (
            <span key={risk} className="flex items-center gap-1.5">
              <span
                className="h-2.5 w-2.5 rounded-full"
                style={{ backgroundColor: color }}
              />
              {risk === "safe"
                ? tr("安全", "Safe")
                : risk === "info"
                  ? tr("活动", "Activity")
                  : risk === "warning"
                    ? tr("注意", "Caution")
                    : risk === "danger"
                      ? tr("危险", "Danger")
                      : tr("严重", "Critical")}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={tr("放大星图", "Zoom in")}
            onClick={() => setView((current) => zoomedView(current, 0.8))}
          >
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={tr("缩小星图", "Zoom out")}
            onClick={() => setView((current) => zoomedView(current, 1.25))}
          >
            <ZoomOut className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            aria-label={tr("重置星图", "Reset map")}
            onClick={resetView}
          >
            <LocateFixed className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div className="relative overflow-hidden rounded-lg border border-sky-500/20 bg-slate-950 shadow-inner">
        <div className="pointer-events-none absolute left-3 top-3 z-10 rounded border border-sky-400/20 bg-slate-950/80 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-sky-200/70 backdrop-blur">
          {coordinateMode === "actual"
            ? tr("游戏二维星图坐标", "In-game 2D map coordinates")
            : coordinateMode === "partial"
              ? tr("部分坐标·混合布局", "Partial coordinates · mixed layout")
              : tr(
                  "坐标同步中·临时布局",
                  "Coordinates pending · temporary layout",
                )}
        </div>
        <svg
          className="block h-[420px] w-full cursor-grab touch-none select-none active:cursor-grabbing sm:h-[500px]"
          viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label={tr("实时星系预警图", "Live solar-system alert map")}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
        >
          <defs>
            <pattern
              id="system-intel-grid"
              width="40"
              height="40"
              patternUnits="userSpaceOnUse"
            >
              <path
                d="M 40 0 L 0 0 0 40"
                fill="none"
                stroke="#38bdf8"
                strokeOpacity="0.055"
                strokeWidth="1"
              />
            </pattern>
            <filter
              id="system-intel-glow"
              x="-80%"
              y="-80%"
              width="260%"
              height="260%"
            >
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <rect
            x={view.x}
            y={view.y}
            width={view.width}
            height={view.height}
            fill="url(#system-intel-grid)"
          />
          <g data-map-layer="edges" aria-hidden="true" pointerEvents="none">
            {map.edges.map((edge) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) return null;
              return (
                <line
                  key={`${edge.from}-${edge.to}`}
                  x1={from.position.x}
                  y1={from.position.y}
                  x2={to.position.x}
                  y2={to.position.y}
                  stroke="#7dd3fc"
                  strokeOpacity="0.22"
                  strokeWidth="1.4"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </g>
          {/* Leaders are deliberately below every node and every label so a
              later system can never draw a line across an earlier name. */}
          <g data-map-layer="leaders" aria-hidden="true" pointerEvents="none">
            {map.nodes.map((node) => {
              const label = labelPlacements.get(node.solarSystemId);
              if (!label) return null;
              const risk = node.monitor?.risk ?? "safe";
              const color = RISK_COLORS[risk] ?? RISK_COLORS.safe;
              return (
                <line
                  key={node.solarSystemId}
                  x1={label.leader.start.x}
                  y1={label.leader.start.y}
                  x2={label.leader.end.x}
                  y2={label.leader.end.y}
                  stroke={color}
                  strokeOpacity={node.monitor ? 0.55 : 0.35}
                  strokeWidth="1"
                  vectorEffect="non-scaling-stroke"
                />
              );
            })}
          </g>
          <g data-map-layer="nodes">
            {map.nodes.map((node) => {
              const risk = node.monitor?.risk ?? "safe";
              const color = RISK_COLORS[risk] ?? RISK_COLORS.safe;
              const peopleCount = nodePeopleCount(node);
              const activityRadius = nodeActivityRadius(node);
              const circleRadius = nodeCircleRadius(node);
              const selected = node.solarSystemId === selectedSystemId;
              return (
                <g
                  key={node.solarSystemId}
                  className="cursor-pointer"
                  role={node.monitor ? "button" : undefined}
                  tabIndex={node.monitor ? 0 : undefined}
                  aria-label={`${node.solarSystemName} ${risk}`}
                  transform={`translate(${node.position.x} ${node.position.y})`}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectNode(node);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onKeyDown={(event) => handleNodeKeyDown(event, node)}
                  onPointerEnter={() => startNodeHover(node.solarSystemId)}
                  onPointerLeave={() => endNodeHover(node.solarSystemId)}
                  onFocus={() => startNodeHover(node.solarSystemId)}
                  onBlur={() => endNodeHover(node.solarSystemId)}
                >
                  {node.activeEvents.length > 0 && (
                    <circle
                      r={activityRadius + 11}
                      fill="none"
                      stroke={color}
                      strokeOpacity="0.45"
                      strokeWidth="2"
                      className="animate-pulse"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {selected && (
                    <circle
                      r={activityRadius + 7}
                      fill="none"
                      stroke="#e0f2fe"
                      strokeOpacity="0.9"
                      strokeWidth="1.5"
                      strokeDasharray="3 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  <circle
                    r={circleRadius}
                    fill={color}
                    fillOpacity={node.monitor ? 0.95 : 0.35}
                    stroke={node.monitor ? "#e0f2fe" : color}
                    strokeOpacity={node.monitor ? 0.55 : 0.25}
                    strokeWidth="1"
                    filter={
                      RISK_RANK[risk] >= RISK_RANK.danger
                        ? "url(#system-intel-glow)"
                        : undefined
                    }
                    vectorEffect="non-scaling-stroke"
                  />
                  <title>
                    {node.solarSystemName} · {localizedRisk(risk, zh)} ·{" "}
                    {tr("击杀", "Kills")} {node.monitor?.recentKillCount ?? 0} ·{" "}
                    {tr("人数", "People")} {peopleCount} ·{" "}
                    {tr("警报", "Alerts")} {node.monitor?.activeEventCount ?? 0}
                  </title>
                </g>
              );
            })}
          </g>
          <g data-map-layer="labels">
            {map.nodes.map((node) => {
              const label = labelPlacements.get(node.solarSystemId);
              if (!label) return null;
              const risk = node.monitor?.risk ?? "safe";
              const color = RISK_COLORS[risk] ?? RISK_COLORS.safe;
              const selected = node.solarSystemId === selectedSystemId;
              const labelScale = view.width / CANVAS_WIDTH;
              const labelPaddingX = 5 * labelScale;
              const labelPaddingY = 3.5 * labelScale;
              return (
                <g
                  key={node.solarSystemId}
                  className="cursor-pointer"
                  aria-hidden="true"
                  onClick={(event) => {
                    event.stopPropagation();
                    selectNode(node);
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  onPointerEnter={() => startNodeHover(node.solarSystemId)}
                  onPointerLeave={() => endNodeHover(node.solarSystemId)}
                >
                  <rect
                    x={label.box.x}
                    y={label.box.y}
                    width={label.box.width}
                    height={label.box.height}
                    rx={3 * labelScale}
                    fill="#020617"
                    fillOpacity="0.88"
                    stroke={selected ? "#e0f2fe" : color}
                    strokeOpacity={node.monitor ? 0.46 : 0.3}
                    strokeWidth="1"
                    vectorEffect="non-scaling-stroke"
                  />
                  <text
                    x={label.box.x + labelPaddingX}
                    y={label.box.y + labelPaddingY + label.fontSize}
                    fill={node.monitor ? "#e0f2fe" : "#cbd5e1"}
                    fillOpacity={node.monitor ? 0.98 : 0.82}
                    fontSize={label.fontSize}
                    fontWeight={node.monitor ? "600" : "400"}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                  >
                    {node.solarSystemName}
                  </text>
                  {label.detail && (
                    <text
                      x={label.box.x + labelPaddingX}
                      y={
                        label.box.y +
                        labelPaddingY +
                        label.fontSize +
                        2 * labelScale +
                        label.detailFontSize
                      }
                      fill={color}
                      fillOpacity="0.85"
                      fontSize={label.detailFontSize}
                      fontWeight="600"
                      fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    >
                      {label.detail}
                    </text>
                  )}
                  <title>{node.solarSystemName}</title>
                </g>
              );
            })}
          </g>
        </svg>

        {selectedNode && (
          <div className="absolute bottom-3 left-3 right-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-sky-400/20 bg-slate-950/85 p-3 text-slate-100 backdrop-blur sm:left-auto sm:max-w-sm">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2 font-mono font-semibold">
                <Crosshair
                  className="h-4 w-4"
                  style={{
                    color: RISK_COLORS[selectedNode.monitor?.risk ?? "safe"],
                  }}
                />
                {selectedNode.solarSystemName}
                {selectedNode.monitor && (
                  <span
                    className="rounded border px-1.5 py-0.5 text-[10px]"
                    style={{
                      borderColor:
                        RISK_COLORS[selectedNode.monitor.risk] ??
                        RISK_COLORS.safe,
                      color:
                        RISK_COLORS[selectedNode.monitor.risk] ??
                        RISK_COLORS.safe,
                    }}
                  >
                    {localizedRisk(selectedNode.monitor.risk, zh)}
                  </span>
                )}
              </div>
              {selectedNode.monitor ? (
                <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-400">
                  <span>
                    {tr("击杀", "Kills")} {selectedNode.monitor.recentKillCount}
                  </span>
                  <span>
                    {tr("报告/参与人数", "Reported/participants")}{" "}
                    {nodePeopleCount(selectedNode)}
                  </span>
                  <span>
                    {tr("警报", "Alerts")}{" "}
                    {selectedNode.monitor.activeEventCount}
                  </span>
                  {selectedNode.activeEvents.length > 0 && (
                    <span>
                      {tr("剩余", "Remaining")}{" "}
                      {Math.max(
                        ...selectedNode.activeEvents.map(
                          (event) => remainingMinutes(event) ?? 0,
                        ),
                      )}{" "}
                      {tr("分钟", "min")}
                    </span>
                  )}
                </div>
              ) : (
                <div className="mt-1 text-xs text-slate-500">
                  {tr("星图参照星系", "Map context system")}
                </div>
              )}
            </div>
            {selectedNode.monitor && (
              <div className="flex items-center gap-1 text-[11px] text-sky-300">
                <Network className="h-3.5 w-3.5" />
                {selectedSystemId === selectedNode.solarSystemId
                  ? tr("已选为报告星系", "Selected for report")
                  : tr("点击节点可选为报告星系", "Click node to target report")}
              </div>
            )}
          </div>
        )}
      </div>

      <p className="px-1 text-xs text-muted-foreground">
        {tr(
          "滚轮缩放、拖动平移，点击监控星系可直接选中下方报告目标。连线仅显示已同步的星门拓扑。",
          "Scroll to zoom, drag to pan, and select a monitored system to target the report form. Lines only show synchronized stargate topology.",
        )}
      </p>
    </div>
  );
}
