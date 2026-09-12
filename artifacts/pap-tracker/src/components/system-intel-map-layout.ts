export type MapLabelCoordinate = {
  x: number;
  y: number;
};

export type MapLabelBox = MapLabelCoordinate & {
  width: number;
  height: number;
};

export type MapLabelNode = {
  id: number;
  name: string;
  position: MapLabelCoordinate;
  radius: number;
  isMonitored: boolean;
  hasActiveAlert: boolean;
  isContextVisible: boolean;
  detail: string | null;
  /** Explicit visibility overrides the legacy monitored/alert/context rules. */
  showLabel?: boolean;
  /** Higher values place first, so focused systems get the nearest clear slot. */
  priority?: number;
};

export type MapLabelPlacement = {
  box: MapLabelBox;
  fontSize: number;
  detailFontSize: number;
  detail: string | null;
  leader: {
    start: MapLabelCoordinate;
    end: MapLabelCoordinate;
  };
};

export type MapLabelLayoutOptions = {
  width: number;
  height: number;
  scale: number;
  /** Visible SVG/map-coordinate rectangle, including the current pan offset. */
  bounds?: MapLabelBox;
  /** Maximum node-to-nearest-label-edge distance, in SVG/map coordinates. */
  maxDistance?: number;
};

const BOX_GAP = 3;
const EDGE_MARGIN = 8;
const MAX_PLACEMENT_LAYERS = 10;

function textWidth(text: string, fontSize: number): number {
  return Array.from(text).reduce(
    (width, character) =>
      width + fontSize * (character.codePointAt(0)! > 0x7f ? 1 : 0.62),
    0,
  );
}

function overlapArea(left: MapLabelBox, right: MapLabelBox, gap: number) {
  const width =
    Math.min(left.x + left.width + gap, right.x + right.width + gap) -
    Math.max(left.x - gap, right.x - gap);
  const height =
    Math.min(left.y + left.height + gap, right.y + right.height + gap) -
    Math.max(left.y - gap, right.y - gap);
  return width > 0 && height > 0 ? width * height : 0;
}

function clampBox(
  box: MapLabelBox,
  bounds: MapLabelBox,
  margin: number,
): MapLabelBox | null {
  if (
    box.width > bounds.width - margin * 2 ||
    box.height > bounds.height - margin * 2
  ) {
    return null;
  }
  return {
    ...box,
    x: Math.min(
      bounds.x + bounds.width - margin - box.width,
      Math.max(bounds.x + margin, box.x),
    ),
    y: Math.min(
      bounds.y + bounds.height - margin - box.height,
      Math.max(bounds.y + margin, box.y),
    ),
  };
}

function distanceToBox(point: MapLabelCoordinate, box: MapLabelBox): number {
  const dx = Math.max(box.x - point.x, 0, point.x - box.x - box.width);
  const dy = Math.max(box.y - point.y, 0, point.y - box.y - box.height);
  return Math.hypot(dx, dy);
}

function candidateBoxes(
  node: MapLabelNode,
  width: number,
  height: number,
  scale: number,
  bounds: MapLabelBox,
  maxDistance: number,
): MapLabelBox[] {
  const candidates: MapLabelBox[] = [];
  const baseGap = 7 * scale;
  const layerGap = 5 * scale;
  const margin = EDGE_MARGIN * scale;
  const dedupe = new Set<string>();

  const add = (x: number, y: number) => {
    const box = clampBox({ x, y, width, height }, bounds, margin);
    if (!box || distanceToBox(node.position, box) > maxDistance) return;
    const key = `${box.x.toFixed(3)}:${box.y.toFixed(3)}`;
    if (dedupe.has(key)) return;
    dedupe.add(key);
    candidates.push(box);
  };

  for (let layer = 0; layer < MAX_PLACEMENT_LAYERS; layer += 1) {
    const verticalDistance =
      node.radius + baseGap + layer * (height + layerGap);
    const horizontalDistance =
      node.radius +
      baseGap +
      layer * (Math.min(width * 0.5, 54 * scale) + layerGap);

    // Adjacent positions suit vertical chains. Above/below positions naturally
    // stagger dense horizontal chains into deterministic tiers.
    add(node.position.x + horizontalDistance, node.position.y - height / 2);
    add(
      node.position.x - horizontalDistance - width,
      node.position.y - height / 2,
    );
    add(
      node.position.x - width / 2,
      node.position.y - verticalDistance - height,
    );
    add(node.position.x - width / 2, node.position.y + verticalDistance);

    add(
      node.position.x + node.radius + baseGap,
      node.position.y - verticalDistance - height,
    );
    add(
      node.position.x - node.radius - baseGap - width,
      node.position.y - verticalDistance - height,
    );
    add(
      node.position.x + node.radius + baseGap,
      node.position.y + verticalDistance,
    );
    add(
      node.position.x - node.radius - baseGap - width,
      node.position.y + verticalDistance,
    );
  }

  return candidates;
}

function fallbackGridBoxes(
  node: MapLabelNode,
  width: number,
  height: number,
  scale: number,
  bounds: MapLabelBox,
  maxDistance: number,
): MapLabelBox[] {
  const margin = EDGE_MARGIN * scale;
  const xStep = Math.max(5 * scale, Math.min(width / 4, 16 * scale));
  const yStep = Math.max(5 * scale, Math.min(height / 2, 12 * scale));
  const boxes: MapLabelBox[] = [];

  const minX = Math.max(
    bounds.x + margin,
    node.position.x - maxDistance - width,
  );
  const minY = Math.max(
    bounds.y + margin,
    node.position.y - maxDistance - height,
  );
  const maxX = Math.min(
    bounds.x + bounds.width - margin - width,
    node.position.x + maxDistance,
  );
  const maxY = Math.min(
    bounds.y + bounds.height - margin - height,
    node.position.y + maxDistance,
  );

  for (let y = minY; y <= maxY; y += yStep) {
    for (let x = minX; x <= maxX; x += xStep) {
      const box = { x, y, width, height };
      if (distanceToBox(node.position, box) <= maxDistance) boxes.push(box);
    }
  }

  return boxes.sort((left, right) => {
    const leftDistance = Math.hypot(
      left.x + left.width / 2 - node.position.x,
      left.y + left.height / 2 - node.position.y,
    );
    const rightDistance = Math.hypot(
      right.x + right.width / 2 - node.position.x,
      right.y + right.height / 2 - node.position.y,
    );
    return leftDistance - rightDistance || left.y - right.y || left.x - right.x;
  });
}

function leaderFor(
  node: MapLabelNode,
  box: MapLabelBox,
  scale: number,
): MapLabelPlacement["leader"] {
  const end = {
    x: Math.min(box.x + box.width, Math.max(box.x, node.position.x)),
    y: Math.min(box.y + box.height, Math.max(box.y, node.position.y)),
  };
  const dx = end.x - node.position.x;
  const dy = end.y - node.position.y;
  const distance = Math.hypot(dx, dy);
  const startDistance = node.radius + 2 * scale;
  const ratio = distance > 0 ? Math.min(1, startDistance / distance) : 0;
  return {
    start: {
      x: node.position.x + dx * ratio,
      y: node.position.y + dy * ratio,
    },
    end,
  };
}

function labelRank(node: MapLabelNode): number {
  if (node.priority !== undefined) return node.priority;
  // Preserve legacy order when the caller has not supplied focus priorities.
  if (node.isMonitored) return 3;
  if (node.hasActiveAlert) return 2;
  return 1;
}

export function layoutMapLabels(
  nodes: MapLabelNode[],
  options: MapLabelLayoutOptions,
): Map<number, MapLabelPlacement> {
  const scale =
    Number.isFinite(options.scale) && options.scale > 0 ? options.scale : 1;
  const bounds = options.bounds ?? {
    x: 0,
    y: 0,
    width: options.width,
    height: options.height,
  };
  const maxDistance = Math.max(0, options.maxDistance ?? Infinity);
  const placed = new Map<number, MapLabelPlacement>();
  if (bounds.width <= 0 || bounds.height <= 0) return placed;
  const occupied: MapLabelBox[] = [];
  const nodeObstacles = nodes.map((node) => {
    const radius = node.radius + 3 * scale;
    return {
      x: node.position.x - radius,
      y: node.position.y - radius,
      width: radius * 2,
      height: radius * 2,
    };
  });
  const eligible = nodes
    .filter(
      (node) =>
        (node.showLabel ??
          (node.isMonitored || node.hasActiveAlert || node.isContextVisible)) &&
        node.position.x >= bounds.x &&
        node.position.x <= bounds.x + bounds.width &&
        node.position.y >= bounds.y &&
        node.position.y <= bounds.y + bounds.height,
    )
    .sort(
      (left, right) =>
        labelRank(right) - labelRank(left) ||
        left.position.y - right.position.y ||
        left.position.x - right.position.x ||
        left.id - right.id,
    );

  for (const node of eligible) {
    const fontSize = (node.isMonitored ? 13 : 10) * scale;
    const detailFontSize = 9 * scale;
    const paddingX = 5 * scale;
    const paddingY = 3.5 * scale;
    const detailGap = node.detail ? 2 * scale : 0;
    const width =
      Math.max(
        textWidth(node.name, fontSize),
        node.detail ? textWidth(node.detail, detailFontSize) : 0,
      ) +
      paddingX * 2;
    const height =
      paddingY * 2 + fontSize + (node.detail ? detailGap + detailFontSize : 0);
    const candidates = candidateBoxes(
      node,
      width,
      height,
      scale,
      bounds,
      maxDistance,
    );
    const isLabelClear = (box: MapLabelBox) =>
      occupied.every((other) => overlapArea(box, other, BOX_GAP * scale) === 0);
    const nodeOverlap = (box: MapLabelBox) =>
      nodeObstacles.reduce(
        (sum, obstacle) => sum + overlapArea(box, obstacle, 2 * scale),
        0,
      );
    let bestBox = candidates.find(
      (box) => isLabelClear(box) && nodeOverlap(box) === 0,
    );

    if (!bestBox) {
      const fallback = fallbackGridBoxes(
        node,
        width,
        height,
        scale,
        bounds,
        maxDistance,
      );
      bestBox = fallback.find(
        (box) => isLabelClear(box) && nodeOverlap(box) === 0,
      );
    }

    if (!bestBox) continue;
    occupied.push(bestBox);
    placed.set(node.id, {
      box: bestBox,
      fontSize,
      detailFontSize,
      detail: node.detail,
      leader: leaderFor(node, bestBox, scale),
    });
  }

  return placed;
}

export function labelBoxesOverlap(
  left: MapLabelBox,
  right: MapLabelBox,
): boolean {
  return overlapArea(left, right, 0) > 0;
}
