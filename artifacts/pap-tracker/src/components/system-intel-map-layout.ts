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

type LayoutOptions = {
  width: number;
  height: number;
  scale: number;
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
  canvasWidth: number,
  canvasHeight: number,
  margin: number,
): MapLabelBox {
  return {
    ...box,
    x: Math.min(canvasWidth - margin - box.width, Math.max(margin, box.x)),
    y: Math.min(canvasHeight - margin - box.height, Math.max(margin, box.y)),
  };
}

function candidateBoxes(
  node: MapLabelNode,
  width: number,
  height: number,
  scale: number,
  canvasWidth: number,
  canvasHeight: number,
): MapLabelBox[] {
  const candidates: MapLabelBox[] = [];
  const baseGap = 7 * scale;
  const layerGap = 5 * scale;
  const margin = EDGE_MARGIN * scale;
  const dedupe = new Set<string>();

  const add = (x: number, y: number) => {
    const box = clampBox(
      { x, y, width, height },
      canvasWidth,
      canvasHeight,
      margin,
    );
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
  canvasWidth: number,
  canvasHeight: number,
): MapLabelBox[] {
  const margin = EDGE_MARGIN * scale;
  const xStep = Math.max(5 * scale, Math.min(width / 4, 16 * scale));
  const yStep = Math.max(5 * scale, Math.min(height / 2, 12 * scale));
  const boxes: MapLabelBox[] = [];

  for (let y = margin; y <= canvasHeight - margin - height; y += yStep) {
    for (let x = margin; x <= canvasWidth - margin - width; x += xStep) {
      boxes.push({ x, y, width, height });
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
  // Monitored systems always retain their names. Alert-only nodes precede
  // transient hover/selection context without depending on live risk values.
  if (node.isMonitored) return 3;
  if (node.hasActiveAlert) return 2;
  return 1;
}

export function layoutMapLabels(
  nodes: MapLabelNode[],
  options: LayoutOptions,
): Map<number, MapLabelPlacement> {
  const scale = Math.max(0.2, options.scale);
  const placed = new Map<number, MapLabelPlacement>();
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
        node.isMonitored || node.hasActiveAlert || node.isContextVisible,
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
      options.width,
      options.height,
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
        options.width,
        options.height,
      );
      bestBox = fallback.find(
        (box) => isLabelClear(box) && nodeOverlap(box) === 0,
      );

      // A label may cross a node only when the canvas has no fully clear slot.
      // It still never covers another name.
      if (!bestBox) {
        bestBox = [...candidates, ...fallback]
          .filter(isLabelClear)
          .map((box) => ({ box, nodeOverlap: nodeOverlap(box) }))
          .sort(
            (left, right) =>
              left.nodeOverlap - right.nodeOverlap ||
              Math.hypot(
                left.box.x + left.box.width / 2 - node.position.x,
                left.box.y + left.box.height / 2 - node.position.y,
              ) -
                Math.hypot(
                  right.box.x + right.box.width / 2 - node.position.x,
                  right.box.y + right.box.height / 2 - node.position.y,
                ) ||
              left.box.y - right.box.y ||
              left.box.x - right.box.x,
          )[0]?.box;
      }
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
