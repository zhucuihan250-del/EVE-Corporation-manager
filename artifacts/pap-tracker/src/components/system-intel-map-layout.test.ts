import assert from "node:assert/strict";
import test from "node:test";
import {
  labelBoxesOverlap,
  layoutMapLabels,
  type MapLabelNode,
} from "./system-intel-map-layout.ts";

const options = { width: 1_000, height: 560, scale: 1 };

function monitoredNode(id: number, x: number, y: number): MapLabelNode {
  return {
    id,
    name: `74L2-${String(id).padStart(2, "0")}`,
    position: { x, y },
    radius: 17,
    isMonitored: true,
    hasActiveAlert: id % 3 === 0,
    isContextVisible: false,
    detail: id % 3 === 0 ? `人数 ${id}` : null,
  };
}

function assertNoLabelOverlap(nodes: MapLabelNode[]) {
  const entries = [...layoutMapLabels(nodes, options).entries()];
  const placements = entries.map(([, placement]) => placement);
  assert.equal(entries.length, nodes.length);
  entries.forEach(([id, left], leftIndex) => {
    entries.slice(leftIndex + 1).forEach(([, right]) => {
      assert.equal(
        labelBoxesOverlap(left.box, right.box),
        false,
        `labels overlap: ${JSON.stringify(left.box)} / ${JSON.stringify(right.box)}`,
      );
    });
    nodes.forEach((node) => {
      const obstaclePadding = 3;
      const radius = node.radius + obstaclePadding;
      assert.equal(
        labelBoxesOverlap(left.box, {
          x: node.position.x - radius,
          y: node.position.y - radius,
          width: radius * 2,
          height: radius * 2,
        }),
        false,
        `label ${id} covers node ${node.id}`,
      );
    });
  });
  return placements;
}

test("dense horizontal chains use multiple tiers without overlapping labels", () => {
  const nodes = Array.from({ length: 12 }, (_, index) =>
    monitoredNode(index + 1, 390 + index * 19, 280),
  );
  const placements = assertNoLabelOverlap(nodes);
  assert.ok(new Set(placements.map(({ box }) => Math.round(box.y))).size >= 3);
  assert.ok(placements.some(({ box }) => box.y < 250));
  assert.ok(placements.some(({ box }) => box.y > 285));
});

test("dense vertical chains retain every monitored name without overlap", () => {
  const nodes = Array.from({ length: 12 }, (_, index) =>
    monitoredNode(index + 1, 500, 165 + index * 20),
  );
  assertNoLabelOverlap(nodes);
});

test("ordinary context names appear only while selected or hovered", () => {
  const nodes: MapLabelNode[] = [
    monitoredNode(1, 400, 280),
    {
      ...monitoredNode(2, 500, 280),
      isMonitored: false,
      hasActiveAlert: false,
      isContextVisible: false,
    },
    {
      ...monitoredNode(3, 600, 280),
      isMonitored: false,
      hasActiveAlert: false,
      isContextVisible: true,
    },
  ];
  const placements = layoutMapLabels(nodes, options);
  assert.equal(placements.has(1), true);
  assert.equal(placements.has(2), false);
  assert.equal(placements.has(3), true);
});

test("identical input produces stable deterministic placements", () => {
  const nodes = Array.from({ length: 12 }, (_, index) =>
    monitoredNode(index + 1, 390 + index * 19, 280),
  );
  assert.deepEqual(
    [...layoutMapLabels(nodes, options).entries()],
    [...layoutMapLabels(nodes, options).entries()],
  );
});
