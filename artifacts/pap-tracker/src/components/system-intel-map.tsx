import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  SystemIntelEvent,
  SystemMonitorSummary,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Crosshair,
  Eye,
  EyeOff,
  LocateFixed,
  Maximize2,
  Minimize2,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { layoutMapLabels } from "./system-intel-map-layout";
import { getSystemMapRisk } from "./system-intel-map-risk";

const CANVAS_WIDTH = 1_000;
const CANVAS_HEIGHT = 560;
const MIN_VIEW_WIDTH = 100;
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
  securityStatus: number | null;
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
    securityStatus: number | null;
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
    securityStatus: finiteNumber(value.securityStatus),
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
      securityStatus: payloadNode?.securityStatus ?? null,
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
  const height = width * (view.height / view.width);
  return {
    x: view.x + (view.width - width) / 2,
    y: view.y + (view.height - height) / 2,
    width,
    height,
  };
}

function overviewView(width: number, height: number): ViewBox {
  const viewWidth = Math.max(CANVAS_WIDTH, (CANVAS_HEIGHT * width) / height);
  const viewHeight = (viewWidth * height) / width;
  return {
    x: (CANVAS_WIDTH - viewWidth) / 2,
    y: (CANVAS_HEIGHT - viewHeight) / 2,
    width: viewWidth,
    height: viewHeight,
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

function nodeRisk(node: MapNode): string {
  return getSystemMapRisk(node.activeEvents, node.monitor);
}

function securityColor(security: number | null): string {
  if (security === null) return "#8693a4";
  if (security >= 0.85) return "#59a8e8";
  if (security >= 0.65) return "#68c3b1";
  if (security >= 0.45) return "#a4cf72";
  if (security >= 0.25) return "#e8c45e";
  if (security > 0) return "#e38c50";
  return "#ce6576";
}

function localizedRisk(risk: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    safe: ["暂无有效预警", "No active alerts"],
    info: ["有活动", "Activity"],
    warning: ["注意", "Caution"],
    danger: ["危险", "Danger"],
    critical: ["严重", "Critical"],
  };
  return labels[risk]?.[zh ? 0 : 1] ?? risk;
}

function eventLabel(event: SystemIntelEvent, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    hostile_report: ["敌情报告", "Hostile report"],
    player_kill: ["玩家击杀", "Player kill"],
    corporation_loss: ["军团损失", "Corporation loss"],
    kill_burst: ["连续击杀", "Kill burst"],
    special_ship: ["特殊舰船", "Special ship"],
    high_value: ["高价值损失", "High-value loss"],
    activity_spike: ["活动异常", "Activity spike"],
  };
  return labels[event.eventType]?.[zh ? 0 : 1] ?? event.eventType;
}

export function SystemIntelMap({
  monitors,
  events,
  dashboardData,
  zh,
  onSelectMonitor,
}: SystemIntelMapProps) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [now, setNow] = useState(Date.now);
  const map = useMemo(
    () => buildMap(monitors, events, dashboardData),
    [dashboardData, events, monitors, now],
  );
  const [view, setView] = useState<ViewBox>({
    x: 0,
    y: 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
  });
  const [selectedSystemId, setSelectedSystemId] = useState<number | null>(null);
  const [hoveredSystemId, setHoveredSystemId] = useState<number | null>(null);
  const [pointer, setPointer] = useState<Coordinate | null>(null);
  const [nameMode, setNameMode] = useState<"auto" | "hover">("auto");
  const [colorMode, setColorMode] = useState<"security" | "intel">("security");
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [plotSize, setPlotSize] = useState({ width: 1_000, height: 560 });
  const plotRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const expandButtonRef = useRef<HTMLButtonElement>(null);
  const hoverClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    view: ViewBox;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const overviewRef = useRef(true);
  const svgId = useId().replace(/:/g, "");
  const pixelScale = view.width / Math.max(1, plotSize.width);
  const zoom = CANVAS_WIDTH / view.width;
  const nodeById = useMemo(
    () => new Map(map.nodes.map((node) => [node.solarSystemId, node])),
    [map.nodes],
  );
  const selectedNode =
    selectedSystemId === null ? null : (nodeById.get(selectedSystemId) ?? null);
  const hoveredNode =
    hoveredSystemId === null ? null : (nodeById.get(hoveredSystemId) ?? null);
  const inspectedNode = hoveredNode ?? selectedNode;
  const inspectedRisk = inspectedNode ? nodeRisk(inspectedNode) : "safe";
  const alertNodes = map.nodes.filter((node) => node.activeEvents.length > 0);
  const coordinateMode =
    map.coordinateCount === map.nodes.length
      ? "actual"
      : map.coordinateCount > 0
        ? "partial"
        : "fallback";
  const focusedConnections = useMemo(() => {
    const id = hoveredSystemId ?? selectedSystemId;
    return new Set(
      map.edges.flatMap((edge) =>
        edge.from === id ? [edge.to] : edge.to === id ? [edge.from] : [],
      ),
    );
  }, [map.edges, hoveredSystemId, selectedSystemId]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(
    () => () => {
      if (hoverClearTimerRef.current) clearTimeout(hoverClearTimerRef.current);
    },
    [],
  );
  useEffect(() => {
    const plot = plotRef.current;
    if (!plot) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      setPlotSize({ width, height });
      setView((current) => {
        if (overviewRef.current) return overviewView(width, height);
        const nextHeight = (current.width * height) / width;
        return {
          ...current,
          y: current.y + (current.height - nextHeight) / 2,
          height: nextHeight,
        };
      });
    });
    observer.observe(plot);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    // React's delegated wheel listener is passive. A native listener keeps
    // map zoom from scrolling the surrounding page at the same time.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const transform = svg.getScreenCTM();
      if (!transform) return;
      const cursor = new DOMPoint(event.clientX, event.clientY).matrixTransform(
        transform.inverse(),
      );
      overviewRef.current = false;
      const factor = event.deltaY > 0 ? 1.15 : 0.86;
      setView((current) => {
        const next = zoomedView(current, factor);
        return {
          ...next,
          x: cursor.x - ((cursor.x - current.x) / current.width) * next.width,
          y: cursor.y - ((cursor.y - current.y) / current.height) * next.height,
        };
      });
      setPointer({ x: cursor.x, y: cursor.y });
    };
    svg.addEventListener("wheel", wheel, { passive: false });
    return () => svg.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    if (!expanded) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setExpanded(false);
        expandButtonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", close);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener("keydown", close);
    };
  }, [expanded]);

  const nodeColor = (node: MapNode) =>
    colorMode === "security"
      ? securityColor(node.securityStatus)
      : nodeRisk(node) === "safe"
        ? "#8190a5"
        : RISK_COLORS[nodeRisk(node)];
  const markerRadius = (node: MapNode) => {
    const active = node.activeEvents.length > 0;
    return (
      (active
        ? Math.min(14, 8 + Math.sqrt(nodePeopleCount(node)) * 0.65)
        : node.monitor
          ? 3.2
          : 2.2) * pixelScale
    );
  };
  const nearbyNames = useMemo(() => {
    if (!pointer || nameMode === "hover") return new Set<number>();
    return new Set(
      map.nodes
        .map((node) => ({
          node,
          distance: Math.hypot(
            node.position.x - pointer.x,
            node.position.y - pointer.y,
          ),
        }))
        .filter(({ distance }) => distance < 76 * pixelScale)
        .sort(
          (a, b) =>
            a.distance - b.distance ||
            a.node.solarSystemId - b.node.solarSystemId,
        )
        .slice(0, 5)
        .map(({ node }) => node.solarSystemId),
    );
  }, [map.nodes, pointer, nameMode, pixelScale]);

  const labelPlacements = useMemo(
    () =>
      layoutMapLabels(
        map.nodes.map((node) => {
          const focused =
            node.solarSystemId === hoveredSystemId ||
            node.solarSystemId === selectedSystemId;
          const nearby = nearbyNames.has(node.solarSystemId);
          return {
            id: node.solarSystemId,
            name:
              node.solarSystemName +
              (focused && node.securityStatus !== null
                ? "  " + node.securityStatus.toFixed(1)
                : ""),
            position: node.position,
            radius: Math.max(markerRadius(node), focused ? 11 * pixelScale : 0),
            isMonitored: Boolean(node.monitor),
            hasActiveAlert: node.activeEvents.length > 0,
            isContextVisible: focused,
            showLabel:
              focused ||
              nearby ||
              (nameMode === "auto" &&
                zoom >= 1.8 &&
                (Boolean(node.monitor) || zoom >= 3)),
            priority:
              node.solarSystemId === hoveredSystemId
                ? 100
                : node.solarSystemId === selectedSystemId
                  ? 90
                  : nearby
                    ? 60
                    : node.activeEvents.length
                      ? 30
                      : node.monitor
                        ? 20
                        : 10,
            detail: null,
          };
        }),
        {
          width: CANVAS_WIDTH,
          height: CANVAS_HEIGHT,
          scale: pixelScale,
          bounds: view,
          maxDistance: 52 * pixelScale,
        },
      ),
    [
      map.nodes,
      hoveredSystemId,
      selectedSystemId,
      nearbyNames,
      nameMode,
      zoom,
      pixelScale,
      view,
    ],
  );

  const searchResults = query.trim()
    ? map.nodes
        .filter((node) =>
          node.solarSystemName
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        )
        .sort(
          (a, b) =>
            Number(
              b.solarSystemName
                .toLowerCase()
                .startsWith(query.trim().toLowerCase()),
            ) -
              Number(
                a.solarSystemName
                  .toLowerCase()
                  .startsWith(query.trim().toLowerCase()),
              ) || a.solarSystemName.localeCompare(b.solarSystemName),
        )
        .slice(0, 8)
    : [];

  const startNodeHover = (id: number) => {
    if (hoverClearTimerRef.current) clearTimeout(hoverClearTimerRef.current);
    setHoveredSystemId(id);
  };
  const endNodeHover = (id: number) => {
    if (hoverClearTimerRef.current) clearTimeout(hoverClearTimerRef.current);
    hoverClearTimerRef.current = setTimeout(() => {
      setHoveredSystemId((current) => (current === id ? null : current));
    }, 200);
  };
  const selectNode = (node: MapNode) => {
    if (suppressClickRef.current) return;
    setSelectedSystemId(node.solarSystemId);
    if (node.monitor) onSelectMonitor?.(node.monitor.id);
  };
  const focusNode = (node: MapNode) => {
    selectNode(node);
    overviewRef.current = false;
    const width = Math.min(view.width, 360);
    const height = (width * plotSize.height) / plotSize.width;
    setView({
      x: node.position.x - width / 2,
      y: node.position.y - height / 2,
      width,
      height,
    });
    setQuery("");
    setPointer(null);
    svgRef.current?.focus();
  };
  const resetView = () => {
    overviewRef.current = true;
    setView(overviewView(plotSize.width, plotSize.height));
    setPointer(null);
    setHoveredSystemId(null);
    setSelectedSystemId(null);
  };
  const handleNodeKeyDown = (
    event: ReactKeyboardEvent<SVGGElement>,
    node: MapNode,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    selectNode(node);
  };
  const svgPoint = (clientX: number, clientY: number): Coordinate | null => {
    const transform = svgRef.current?.getScreenCTM();
    if (!transform) return null;
    const point = new DOMPoint(clientX, clientY).matrixTransform(
      transform.inverse(),
    );
    return { x: point.x, y: point.y };
  };
  const handlePointerDown = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    suppressClickRef.current = false;
    dragRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      view,
      moved: false,
    };
  };
  const handlePointerMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      setPointer(svgPoint(event.clientX, event.clientY));
      return;
    }
    const dx = event.clientX - drag.clientX;
    const dy = event.clientY - drag.clientY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    if (!drag.moved) event.currentTarget.setPointerCapture(event.pointerId);
    drag.moved = true;
    overviewRef.current = false;
    suppressClickRef.current = true;
    setPointer(null);
    setHoveredSystemId(null);
    setView({
      ...drag.view,
      x: drag.view.x - (dx * drag.view.width) / plotSize.width,
      y: drag.view.y - (dy * drag.view.height) / plotSize.height,
    });
  };
  const stopDragging = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    // The browser sends click after pointerup. Clear only after that event.
    setTimeout(() => {
      suppressClickRef.current = false;
    }, 0);
  };
  const handleMapKey = (event: ReactKeyboardEvent<SVGSVGElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === "+" || event.key === "=" || event.key === "-") {
      event.preventDefault();
      overviewRef.current = false;
      setPointer(null);
      setView((current) => zoomedView(current, event.key === "-" ? 1.25 : 0.8));
    } else if (
      ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    ) {
      event.preventDefault();
      overviewRef.current = false;
      setPointer(null);
      setView((current) => ({
        ...current,
        x:
          current.x +
          (event.key === "ArrowLeft"
            ? -1
            : event.key === "ArrowRight"
              ? 1
              : 0) *
            current.width *
            0.1,
        y:
          current.y +
          (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0) *
            current.height *
            0.1,
      }));
    } else if (event.key === "Escape") {
      setSelectedSystemId(null);
      setHoveredSystemId(null);
    }
  };

  const detailEvents = [...(inspectedNode?.activeEvents ?? [])].sort(
    (a, b) =>
      RISK_RANK[b.severity] - RISK_RANK[a.severity] ||
      new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime(),
  );
  return (
    <div
      data-testid="system-intel-map"
      className={
        expanded
          ? "fixed inset-2 z-50 flex flex-col overflow-hidden rounded-lg border border-white/15 bg-[#06090e] shadow-2xl sm:inset-5"
          : "overflow-hidden rounded-lg border border-white/10 bg-[#06090e]"
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#0b1119] p-3">
        <div className="relative min-w-40 flex-1 sm:max-w-64">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-500" />
          <Input
            aria-label={tr("搜索图中星系", "Search systems on this map")}
            placeholder={tr("搜索星系，如 74L", "Find a system, e.g. 74L")}
            className="h-9 border-white/10 bg-black/20 pl-8 font-mono text-xs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && searchResults[0]) {
                event.preventDefault();
                focusNode(searchResults[0]);
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query.trim() && (
            <div className="absolute left-0 right-0 top-11 z-30 overflow-hidden rounded-md border border-white/15 bg-[#101822] shadow-xl">
              {searchResults.length ? (
                searchResults.map((node) => (
                  <button
                    type="button"
                    key={node.solarSystemId}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-white/10 focus:bg-white/10 focus:outline-none"
                    onClick={() => focusNode(node)}
                  >
                    <span className="font-mono">{node.solarSystemName}</span>
                    <span className="text-slate-500">
                      {node.monitor
                        ? tr("监控", "Monitored")
                        : tr("邻接", "Neighbor")}
                    </span>
                  </button>
                ))
              ) : (
                <p className="px-3 py-3 text-xs text-slate-400">
                  {tr("图中没有匹配的星系", "No matching system on this map")}
                </p>
              )}
            </div>
          )}
        </div>
        <div
          className="flex h-9 items-center rounded border border-white/10 bg-black/20 p-0.5"
          role="group"
          aria-label={tr("星图着色", "Map color layer")}
        >
          {(["security", "intel"] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              aria-pressed={colorMode === mode}
              onClick={() => setColorMode(mode)}
              className={
                "rounded px-2.5 py-1.5 text-xs transition-colors " +
                (colorMode === mode
                  ? "bg-white/10 text-white"
                  : "text-slate-500 hover:text-slate-200")
              }
            >
              {mode === "security"
                ? tr("安全等级", "Security")
                : tr("预警态势", "Intel")}
            </button>
          ))}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-9 gap-1.5 text-xs text-slate-300"
          aria-pressed={nameMode === "hover"}
          title={tr(
            "按需：鼠标附近或放大时显示；仅悬停：只显示当前目标",
            "On demand: nearby or zoomed-in names; hover only: the focused target",
          )}
          onClick={() => {
            setNameMode((mode) => (mode === "auto" ? "hover" : "auto"));
            setPointer(null);
          }}
        >
          {nameMode === "hover" ? <EyeOff /> : <Eye />}
          {nameMode === "hover"
            ? tr("名称：仅悬停", "Names: hover")
            : tr("名称：按需", "Names: on demand")}
        </Button>
        <div className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400"
            aria-label={tr("缩小星图", "Zoom out")}
            onClick={() => {
              overviewRef.current = false;
              setPointer(null);
              setView((current) => zoomedView(current, 1.25));
            }}
          >
            <ZoomOut />
          </Button>
          <span className="min-w-10 text-center font-mono text-[10px] text-slate-500">
            {Math.round(zoom * 100)}%
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400"
            aria-label={tr("放大星图", "Zoom in")}
            onClick={() => {
              overviewRef.current = false;
              setPointer(null);
              setView((current) => zoomedView(current, 0.8));
            }}
          >
            <ZoomIn />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400"
            aria-label={tr("重置星图", "Reset map")}
            onClick={resetView}
          >
            <LocateFixed />
          </Button>
          <Button
            ref={expandButtonRef}
            type="button"
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-slate-400"
            aria-label={
              expanded
                ? tr("退出大图", "Close expanded map")
                : tr("展开星图", "Expand map")
            }
            aria-pressed={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <Minimize2 /> : <Maximize2 />}
          </Button>
        </div>
      </div>

      <div
        ref={plotRef}
        className={
          expanded
            ? "relative min-h-0 flex-1"
            : "relative h-[420px] sm:h-[540px] xl:h-[600px]"
        }
      >
        <div className="pointer-events-none absolute left-4 top-4 z-10 text-[10px] uppercase tracking-[0.25em] text-slate-500">
          {coordinateMode === "actual"
            ? tr("新伊甸 · 2D", "New Eden · 2D")
            : coordinateMode === "partial"
              ? tr("部分星系坐标待同步", "Some coordinates pending")
              : tr(
                  "坐标待同步 · 临时布局",
                  "Coordinates pending · provisional layout",
                )}
          <div className="mt-1.5 text-[10px] tracking-normal text-slate-600">
            {monitors.length} {tr("监控星系", "monitored systems")} ·{" "}
            {tr("含邻接星系", "with neighbors")}
          </div>
        </div>
        <div className="absolute right-4 top-4 z-10">
          <button
            type="button"
            disabled={!alertNodes.length}
            className="flex items-center gap-2 rounded border border-white/10 bg-[#0a1018]/85 px-2.5 py-1.5 text-[11px] text-slate-400 disabled:cursor-default"
            onClick={() => {
              const currentIndex = alertNodes.findIndex(
                (node) => node.solarSystemId === selectedSystemId,
              );
              focusNode(alertNodes[(currentIndex + 1) % alertNodes.length]);
            }}
            title={tr(
              "定位下一个预警星系",
              "Focus the next system with alerts",
            )}
          >
            <span
              className={
                "h-1.5 w-1.5 rounded-full " +
                (alertNodes.length ? "bg-rose-400" : "bg-slate-600")
              }
            />
            {alertNodes.length
              ? alertNodes.length + " " + tr("处预警", "alert systems")
              : tr("暂无有效预警", "No active alerts")}
          </button>
        </div>
        <svg
          ref={svgRef}
          data-testid="system-map-canvas"
          className="block h-full w-full cursor-grab touch-none select-none focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-300/50 active:cursor-grabbing"
          viewBox={[view.x, view.y, view.width, view.height].join(" ")}
          preserveAspectRatio="xMidYMid meet"
          role="group"
          tabIndex={0}
          aria-label={tr(
            "交互式二维星图，可使用方向键平移和加减键缩放",
            "Interactive 2D map. Use arrow keys to pan and plus or minus to zoom.",
          )}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerCancel={stopDragging}
          onKeyDown={handleMapKey}
          onPointerLeave={() => {
            if (!dragRef.current) {
              setPointer(null);
              if (hoveredSystemId !== null) endNodeHover(hoveredSystemId);
            }
          }}
          onClick={(event) => {
            if (
              event.target === event.currentTarget &&
              !suppressClickRef.current
            )
              setSelectedSystemId(null);
          }}
        >
          <defs>
            {Object.entries(RISK_COLORS)
              .filter(([risk]) => risk !== "safe")
              .map(([risk, color]) => (
                <radialGradient key={risk} id={svgId + "-heat-" + risk}>
                  <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                  <stop offset="50%" stopColor={color} stopOpacity="0.07" />
                  <stop offset="100%" stopColor={color} stopOpacity="0" />
                </radialGradient>
              ))}
          </defs>
          <g data-map-layer="heat" pointerEvents="none" aria-hidden="true">
            {alertNodes.map((node) => (
              <circle
                key={node.solarSystemId}
                cx={node.position.x}
                cy={node.position.y}
                r={markerRadius(node) * (zoom < 1.8 ? 3.4 : 2)}
                fill={"url(#" + svgId + "-heat-" + nodeRisk(node) + ")"}
              />
            ))}
          </g>
          <g data-map-layer="edges" pointerEvents="none" aria-hidden="true">
            {map.edges.map((edge) => {
              const from = nodeById.get(edge.from);
              const to = nodeById.get(edge.to);
              if (!from || !to) return null;
              const focused = [hoveredSystemId, selectedSystemId].some(
                (id) => id === edge.from || id === edge.to,
              );
              const center = {
                x: (from.position.x + to.position.x) / 2,
                y: (from.position.y + to.position.y) / 2,
              };
              return (
                <g key={edge.from + "-" + edge.to}>
                  <line
                    x1={from.position.x}
                    y1={from.position.y}
                    x2={center.x}
                    y2={center.y}
                    stroke={focused ? "#d3e2ef" : nodeColor(from)}
                    strokeOpacity={focused ? 0.72 : 0.22}
                    strokeWidth={focused ? 1.3 : 0.85}
                    vectorEffect="non-scaling-stroke"
                  />
                  <line
                    x1={center.x}
                    y1={center.y}
                    x2={to.position.x}
                    y2={to.position.y}
                    stroke={focused ? "#d3e2ef" : nodeColor(to)}
                    strokeOpacity={focused ? 0.72 : 0.22}
                    strokeWidth={focused ? 1.3 : 0.85}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              );
            })}
          </g>
          <g data-map-layer="leaders" pointerEvents="none" aria-hidden="true">
            {[...labelPlacements].map(([id, label]) =>
              Math.hypot(
                label.leader.end.x - label.leader.start.x,
                label.leader.end.y - label.leader.start.y,
              ) >
              12 * pixelScale ? (
                <line
                  key={id}
                  x1={label.leader.start.x}
                  y1={label.leader.start.y}
                  x2={label.leader.end.x}
                  y2={label.leader.end.y}
                  stroke="#9daab7"
                  strokeOpacity="0.3"
                  strokeWidth="0.6"
                  vectorEffect="non-scaling-stroke"
                />
              ) : null,
            )}
          </g>
          <g data-map-layer="nodes">
            {map.nodes.map((node) => {
              const selected = node.solarSystemId === selectedSystemId;
              const hovered = node.solarSystemId === hoveredSystemId;
              const risk = nodeRisk(node);
              const active = node.activeEvents.length > 0;
              const radius = markerRadius(node);
              const color = nodeColor(node);
              const highlighted =
                selected ||
                hovered ||
                focusedConnections.has(node.solarSystemId);
              const inView =
                node.position.x >= view.x &&
                node.position.x <= view.x + view.width &&
                node.position.y >= view.y &&
                node.position.y <= view.y + view.height;
              const p = pixelScale;
              return (
                <g
                  key={node.solarSystemId}
                  data-system-id={node.solarSystemId}
                  role="button"
                  tabIndex={inView ? 0 : -1}
                  aria-label={
                    node.solarSystemName +
                    " · " +
                    (node.monitor
                      ? localizedRisk(risk, zh)
                      : tr("邻接星系", "Neighbor system"))
                  }
                  aria-pressed={selected}
                  className="cursor-pointer outline-none"
                  transform={
                    "translate(" + node.position.x + " " + node.position.y + ")"
                  }
                  onClick={(event) => {
                    event.stopPropagation();
                    selectNode(node);
                  }}
                  onDoubleClick={() => focusNode(node)}
                  onPointerEnter={() => startNodeHover(node.solarSystemId)}
                  onPointerLeave={() => endNodeHover(node.solarSystemId)}
                  onFocus={() => startNodeHover(node.solarSystemId)}
                  onBlur={() => endNodeHover(node.solarSystemId)}
                  onKeyDown={(event) => handleNodeKeyDown(event, node)}
                >
                  <circle
                    r={Math.max(radius + 3 * p, 8 * p)}
                    fill="transparent"
                  />
                  {active && (
                    <circle
                      r={radius}
                      fill="#070b12"
                      fillOpacity="0.9"
                      stroke={RISK_COLORS[risk]}
                      strokeOpacity="0.85"
                      strokeWidth="1.3"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {selected && (
                    <circle
                      r={Math.max(radius + 4 * p, 9 * p)}
                      fill="none"
                      stroke="#f1f5f9"
                      strokeWidth="1"
                      strokeDasharray="3 3"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {highlighted && !active && (
                    <circle
                      r={7 * p}
                      fill={color}
                      fillOpacity="0.09"
                      stroke={color}
                      strokeWidth="0.7"
                      strokeOpacity="0.6"
                      vectorEffect="non-scaling-stroke"
                    />
                  )}
                  {active && zoom >= 1.8 ? (
                    <text
                      y={3.5 * p}
                      textAnchor="middle"
                      fill={RISK_COLORS[risk]}
                      fontSize={10 * p}
                      fontFamily="ui-monospace, monospace"
                      pointerEvents="none"
                    >
                      {node.activeEvents.length}
                    </text>
                  ) : (
                    <circle
                      r={(active ? 3.2 : node.monitor ? 3 : 2) * p}
                      fill={color}
                      fillOpacity={node.monitor || highlighted ? 1 : 0.55}
                    />
                  )}
                  {risk === "critical" && (
                    <path
                      d={
                        "M " + -3 * p + " " + (-radius - 4 * p) + " h " + 6 * p
                      }
                      stroke={RISK_COLORS.critical}
                      strokeWidth="2"
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  )}
                </g>
              );
            })}
          </g>
          <g data-map-layer="labels" aria-hidden="true">
            {[...labelPlacements].map(([id, label]) => {
              const node = nodeById.get(id);
              if (!node) return null;
              const focused = id === selectedSystemId || id === hoveredSystemId;
              return (
                <g
                  key={id}
                  data-label-system-id={id}
                  className="cursor-pointer"
                  onPointerEnter={() => startNodeHover(id)}
                  onPointerLeave={() => endNodeHover(id)}
                  onClick={(event) => {
                    event.stopPropagation();
                    selectNode(node);
                  }}
                >
                  <rect
                    {...label.box}
                    fill="#06090e"
                    fillOpacity={focused ? 0.93 : 0.5}
                    rx={2 * pixelScale}
                  />
                  <text
                    x={label.box.x + 5 * pixelScale}
                    y={label.box.y + 3.5 * pixelScale + label.fontSize}
                    fill={
                      focused
                        ? "#f1f5f9"
                        : nearbyNames.has(id)
                          ? "#c7d0dc"
                          : "#8997a8"
                    }
                    fontSize={label.fontSize}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
                    paintOrder="stroke"
                    stroke="#06090e"
                    strokeWidth={2 * pixelScale}
                    strokeLinejoin="round"
                  >
                    {node.solarSystemName}
                    {focused && node.securityStatus !== null && (
                      <tspan fill={securityColor(node.securityStatus)}>
                        {"  " + node.securityStatus.toFixed(1)}
                      </tspan>
                    )}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
        <div className="pointer-events-none absolute bottom-3 left-4 right-4 flex flex-wrap items-end justify-between gap-2 text-[10px] text-slate-500">
          <span>
            {nameMode === "hover"
              ? tr("仅显示悬停或选中的名称", "Only hovered or selected names")
              : zoom < 1.8
                ? tr(
                    "总览 · 移到星系附近展开名称",
                    "Overview · move near a star for names",
                  )
                : tr("近景 · 名称自动避让", "Detail · names avoid overlaps")}
          </span>
          <span className="font-mono text-slate-600">
            2D · {tr("滚轮缩放 / 拖动平移", "SCROLL / DRAG")}
          </span>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-t border-white/10 bg-[#0b1119] px-4 py-2.5 text-[10px] text-slate-400">
        <div className="flex flex-wrap items-center gap-3">
          {colorMode === "security" ? (
            <>
              <span className="text-slate-500">
                {tr("星系点：安全等级", "Stars: security")}
              </span>
              {[
                ["#59a8e8", tr("高安", "High-sec")],
                ["#e8c45e", tr("低安", "Low-sec")],
                ["#ce6576", tr("零安", "Null-sec")],
              ].map(([color, text]) => (
                <span key={text} className="flex items-center gap-1.5">
                  <i
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  {text}
                </span>
              ))}
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
              {tr("灰点：暂无有效预警", "Gray: no active alerts")}
            </>
          )}
          <span className="text-slate-600">/</span>
          {(["info", "warning", "danger", "critical"] as const).map((risk) => (
            <span key={risk} className="flex items-center gap-1.5">
              <i
                className="h-2 w-2 rounded-full border"
                style={{ borderColor: RISK_COLORS[risk] }}
              />
              {localizedRisk(risk, zh)}
            </span>
          ))}
        </div>
        <span className="text-slate-500">
          {tr(
            "预警环始终显示 · 圈内为有效报告数",
            "Alert rings always visible · number = active reports",
          )}
        </span>
      </div>

      <div
        data-testid="map-system-details"
        className={
          "border-t border-white/10 px-4 py-3 " +
          (expanded ? "max-h-48 overflow-y-auto" : "min-h-20")
        }
      >
        {inspectedNode ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-2">
                <Crosshair className="h-4 w-4 text-slate-500" />
                <span className="font-mono text-sm font-semibold text-slate-100">
                  {inspectedNode.solarSystemName}
                </span>
                {inspectedNode.securityStatus !== null && (
                  <span
                    className="font-mono text-xs"
                    style={{
                      color: securityColor(inspectedNode.securityStatus),
                    }}
                  >
                    {inspectedNode.securityStatus.toFixed(1)}
                  </span>
                )}
              </div>
              <span
                className="text-xs"
                style={{
                  color: inspectedNode.monitor
                    ? inspectedRisk === "safe"
                      ? "#94a3b8"
                      : RISK_COLORS[inspectedRisk]
                    : "#64748b",
                }}
              >
                {inspectedNode.monitor
                  ? localizedRisk(inspectedRisk, zh)
                  : tr("邻接星系 · 未纳入监控", "Neighbor · not monitored")}
              </span>
              {inspectedNode.monitor && (
                <span className="text-xs text-slate-500">
                  {tr("近期击杀", "Recent kills")}{" "}
                  {inspectedNode.monitor.recentKillCount} ·{" "}
                  {tr("有效报告", "Active reports")}{" "}
                  {inspectedNode.activeEvents.length}
                </span>
              )}
              <div className="ml-auto flex items-center gap-1">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-slate-400"
                  onClick={() => focusNode(inspectedNode)}
                >
                  <LocateFixed className="h-3 w-3" />
                  {tr("定位", "Focus")}
                </Button>
                {selectedNode && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-slate-500"
                    aria-label={tr("取消星系选择", "Clear selection")}
                    onClick={() => {
                      setSelectedSystemId(null);
                      setHoveredSystemId(null);
                      setPointer(null);
                    }}
                  >
                    <X />
                  </Button>
                )}
              </div>
            </div>
            {detailEvents.length ? (
              <div className="space-y-1.5">
                {detailEvents.slice(0, 3).map((event) => (
                  <div
                    key={event.id}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                  >
                    <span style={{ color: RISK_COLORS[event.severity] }}>
                      {eventLabel(event, zh)}
                    </span>
                    {eventPeopleCount(event) > 0 && (
                      <span className="text-slate-400">
                        {event.source === "killmail" ||
                        event.eventType === "kill_burst"
                          ? tr("击杀参与", "Kill participants")
                          : tr("报告人数", "Reported people")}{" "}
                        {eventPeopleCount(event)}
                      </span>
                    )}
                    <span className="text-slate-500">
                      {tr("剩余", "Remaining")} {remainingMinutes(event) ?? "—"}{" "}
                      {tr("分钟", "min")}
                    </span>
                    {event.shipTags.length > 0 && (
                      <span className="text-slate-400">
                        {event.shipTags.join(" / ")}
                      </span>
                    )}
                    <span className="text-slate-600">
                      {event.confidence === "confirmed"
                        ? tr("已确认", "Confirmed")
                        : tr("报告情报", "Reported intel")}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[11px] text-slate-600">
                {inspectedNode.monitor
                  ? tr(
                      "当前没有有效情报；没有报告不代表绝对安全。",
                      "No active intelligence. No report does not guarantee safety.",
                    )
                  : tr(
                      "此星系用于显示星门连接，不代表正在监控其敌情。",
                      "Shown for gate connections; intelligence is not monitored here.",
                    )}
              </p>
            )}
            {selectedNode?.monitor && !hoveredNode && (
              <p className="text-[10px] text-sky-400/70">
                {tr(
                  "已选为下方敌情报告目标",
                  "Selected as the intelligence report target below",
                )}
              </p>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <Crosshair className="h-4 w-4 shrink-0" />
            <div>
              <p>
                {tr(
                  "移到星系上查看情报，点击固定详情，双击放大定位。",
                  "Hover for intelligence, click to pin details, double-click to focus.",
                )}
              </p>
              <p className="mt-1 text-[10px] text-slate-600">
                {tr(
                  "名称按需出现；也可以输入星系名直接定位。",
                  "Names appear on demand. Search to jump directly to a system.",
                )}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
