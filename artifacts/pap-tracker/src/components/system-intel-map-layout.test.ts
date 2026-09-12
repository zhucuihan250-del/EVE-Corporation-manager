import assert from "node:assert/strict";
import test from "node:test";
import {
  labelBoxesOverlap,
  layoutMapLabels,
  type MapLabelLayoutOptions,
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

test("reversed input produces stable deterministic placements", () => {
  const nodes = Array.from({ length: 12 }, (_, index) =>
    monitoredNode(index + 1, 390 + index * 19, 280),
  );
  assert.deepEqual(
    [...layoutMapLabels(nodes, options).entries()],
    [...layoutMapLabels([...nodes].reverse(), options).entries()],
  );
});

test("overview can suppress all permanent names, including monitored alerts", () => {
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    ...monitoredNode(index + 1, 390 + index * 19, 280),
    showLabel: false,
  }));
  assert.equal(layoutMapLabels(nodes, options).size, 0);
});

test("zoom eligibility overrides legacy monitored and context visibility", () => {
  const nodes: MapLabelNode[] = [
    { ...monitoredNode(1, 300, 280), showLabel: false },
    { ...monitoredNode(2, 400, 280), showLabel: true },
    {
      ...monitoredNode(3, 600, 280),
      isMonitored: false,
      hasActiveAlert: false,
      isContextVisible: false,
      showLabel: true,
    },
  ];
  assert.deepEqual([...layoutMapLabels(nodes, options).keys()].sort(), [2, 3]);
});

test("panned viewport bounds contain labels and omit offscreen systems", () => {
  const bounds = { x: 1_200, y: -600, width: 420, height: 240 };
  const nodes = [
    monitoredNode(1, 1_210, -590),
    monitoredNode(2, 1_610, -370),
    monitoredNode(3, 800, 280),
  ];
  const initialPositions = nodes.map(({ position }) => ({ ...position }));
  const placements = layoutMapLabels(nodes, { ...options, bounds });
  assert.equal(placements.size, 2);
  assert.equal(placements.has(3), false);
  for (const { box } of placements.values()) {
    assert.ok(box.x >= bounds.x + 8);
    assert.ok(box.y >= bounds.y + 8);
    assert.ok(box.x + box.width <= bounds.x + bounds.width - 8);
    assert.ok(box.y + box.height <= bounds.y + bounds.height - 8);
  }
  assert.deepEqual(
    nodes.map(({ position }) => position),
    initialPositions,
  );
});

test("focused labels win a crowded local slot regardless of input order", () => {
  const nodes: MapLabelNode[] = [
    {
      ...monitoredNode(1, 35, 40),
      showLabel: true,
      priority: 1,
    },
    {
      ...monitoredNode(2, 35, 40),
      showLabel: true,
      priority: 100,
    },
  ];
  const localOptions: MapLabelLayoutOptions = {
    ...options,
    bounds: { x: 0, y: 0, width: 150, height: 80 },
    maxDistance: 28,
  };
  const placements = layoutMapLabels(nodes, localOptions);
  assert.deepEqual([...placements.keys()], [2]);
  assert.deepEqual(
    [...placements],
    [...layoutMapLabels([...nodes].reverse(), localOptions)],
  );
});

test("bounded local labels disappear instead of drifting across the map", () => {
  const maxDistance = 36;
  const nodes = Array.from({ length: 12 }, (_, index) => ({
    ...monitoredNode(index + 1, 390 + index * 19, 280),
    showLabel: true,
  }));
  const placements = layoutMapLabels(nodes, { ...options, maxDistance });
  assert.ok(placements.size > 0);
  assert.ok(placements.size < nodes.length);
  for (const [id, placement] of placements) {
    const node = nodes.find((candidate) => candidate.id === id)!;
    assert.ok(
      Math.hypot(
        placement.leader.end.x - node.position.x,
        placement.leader.end.y - node.position.y,
      ) <= maxDistance,
    );
    for (const other of placements.values()) {
      if (other === placement) continue;
      assert.equal(labelBoxesOverlap(placement.box, other.box), false);
    }
    for (const obstacle of nodes) {
      const radius = obstacle.radius + 3;
      assert.equal(
        labelBoxesOverlap(placement.box, {
          x: obstacle.position.x - radius,
          y: obstacle.position.y - radius,
          width: radius * 2,
          height: radius * 2,
        }),
        false,
      );
    }
  }
});

test("viewport too small for a label never produces clipped or node-covering boxes", () => {
  const nodes = [
    { ...monitoredNode(1, 20, 20), showLabel: true, priority: 100 },
  ];
  assert.equal(
    layoutMapLabels(nodes, {
      ...options,
      bounds: { x: 0, y: 0, width: 40, height: 40 },
    }).size,
    0,
  );
});

for (const scale of [0.05, 0.1]) {
  test(`high zoom at scale ${scale} keeps 13px names inside the viewport without collisions`, () => {
    const bounds = {
      x: 1_200,
      y: -600,
      width: options.width * scale,
      height: options.height * scale,
    };
    const nodes = Array.from({ length: 12 }, (_, index) => {
      const node = monitoredNode(index + 1, 390 + index * 19, 280);
      return {
        ...node,
        position: {
          x: bounds.x + node.position.x * scale,
          y: bounds.y + node.position.y * scale,
        },
        radius: node.radius * scale,
        showLabel: true,
      };
    });
    const placements = layoutMapLabels(nodes, { ...options, scale, bounds });
    assert.equal(placements.size, nodes.length);
    const epsilon = 1e-9;
    for (const placement of placements.values()) {
      // SVG map units divided by units-per-CSS-pixel give the rendered size.
      assert.ok(Math.abs(placement.fontSize / scale - 13) < epsilon);
      assert.ok(Math.abs(placement.detailFontSize / scale - 9) < epsilon);
      const { box } = placement;
      const margin = 8 * scale;
      assert.ok(box.x >= bounds.x + margin - epsilon);
      assert.ok(box.y >= bounds.y + margin - epsilon);
      assert.ok(
        box.x + box.width <= bounds.x + bounds.width - margin + epsilon,
      );
      assert.ok(
        box.y + box.height <= bounds.y + bounds.height - margin + epsilon,
      );
      for (const other of placements.values()) {
        if (other === placement) continue;
        assert.equal(labelBoxesOverlap(box, other.box), false);
      }
      for (const node of nodes) {
        const radius = node.radius + 3 * scale;
        assert.equal(
          labelBoxesOverlap(box, {
            x: node.position.x - radius,
            y: node.position.y - radius,
            width: radius * 2,
            height: radius * 2,
          }),
          false,
        );
      }
    }
  });
}

test("non-finite or non-positive scales use a finite positive fallback", () => {
  const nodes = [monitoredNode(1, 500, 280)];
  const expected = [...layoutMapLabels(nodes, options)];
  for (const scale of [Number.NaN, Infinity, -Infinity, 0, -1]) {
    assert.deepEqual(
      [...layoutMapLabels(nodes, { ...options, scale })],
      expected,
    );
  }
});
