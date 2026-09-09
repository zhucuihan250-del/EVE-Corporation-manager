import { eveSystemMapEdges, eveSystemMapNodes } from "../data/eve-system-map";

export type SystemMapPosition = {
  x: number;
  y: number;
  z: number;
};

export type SystemMapPosition2D = {
  x: number;
  y: number;
};

export type SystemMapNode = {
  solarSystemId: number;
  solarSystemName: string;
  isMonitored: boolean;
  position: SystemMapPosition;
  mapPosition: SystemMapPosition2D;
  securityStatus: number;
};

export type SystemMapConnection = {
  fromSolarSystemId: number;
  toSolarSystemId: number;
};

type StaticSystemMapNode = Omit<SystemMapNode, "isMonitored">;

const nodesById = new Map<number, StaticSystemMapNode>(
  eveSystemMapNodes.map(
    ([solarSystemId, solarSystemName, mapX, mapY, x, y, z, securityStatus]) => [
      solarSystemId,
      {
        solarSystemId,
        solarSystemName,
        position: { x, y, z },
        mapPosition: { x: mapX, y: mapY },
        securityStatus,
      },
    ],
  ),
);

const neighborsById = new Map<number, Set<number>>();
for (const [from, to] of eveSystemMapEdges) {
  const fromNeighbors = neighborsById.get(from) ?? new Set<number>();
  fromNeighbors.add(to);
  neighborsById.set(from, fromNeighbors);
  const toNeighbors = neighborsById.get(to) ?? new Set<number>();
  toNeighbors.add(from);
  neighborsById.set(to, toNeighbors);
}

export function loadSystemMonitoringMap(input: {
  monitors: Array<{ solarSystemId: number; solarSystemName: string }>;
}): {
  positions: Map<number, SystemMapPosition>;
  mapPositions: Map<number, SystemMapPosition2D>;
  mapNodes: SystemMapNode[];
  connections: SystemMapConnection[];
} {
  const monitoredIds = new Set(
    input.monitors.map((monitor) => monitor.solarSystemId),
  );
  const visibleIds = new Set(monitoredIds);
  for (const solarSystemId of monitoredIds) {
    for (const neighborId of neighborsById.get(solarSystemId) ?? []) {
      visibleIds.add(neighborId);
    }
  }

  const mapNodes = [...visibleIds]
    .flatMap((solarSystemId) => {
      const node = nodesById.get(solarSystemId);
      return node
        ? [{ ...node, isMonitored: monitoredIds.has(solarSystemId) }]
        : [];
    })
    .sort(
      (left, right) =>
        Number(right.isMonitored) - Number(left.isMonitored) ||
        left.solarSystemName.localeCompare(right.solarSystemName, "en", {
          numeric: true,
          sensitivity: "base",
        }),
    );

  const connections = eveSystemMapEdges.flatMap(([from, to]) =>
    visibleIds.has(from) && visibleIds.has(to)
      ? [{ fromSolarSystemId: from, toSolarSystemId: to }]
      : [],
  );
  const monitoredNodes = mapNodes.filter((node) => node.isMonitored);
  return {
    positions: new Map(
      monitoredNodes.map((node) => [node.solarSystemId, node.position]),
    ),
    mapPositions: new Map(
      monitoredNodes.map((node) => [node.solarSystemId, node.mapPosition]),
    ),
    mapNodes,
    connections,
  };
}
