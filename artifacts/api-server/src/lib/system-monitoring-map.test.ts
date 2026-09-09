import assert from "node:assert/strict";
import test from "node:test";
import { loadSystemMonitoringMap } from "./system-monitoring-map";

test("loads official 2D and physical positions with one-hop stargate context", () => {
  const result = loadSystemMonitoringMap({
    monitors: [{ solarSystemId: 30000142, solarSystemName: "Jita" }],
  });
  const jita = result.mapNodes.find((node) => node.solarSystemId === 30000142);
  assert.ok(jita);
  assert.equal(jita.solarSystemName, "Jita");
  assert.equal(jita.isMonitored, true);
  assert.ok(Number.isFinite(jita.position.x));
  assert.ok(Number.isFinite(jita.position.z));
  assert.ok(Number.isFinite(jita.mapPosition.x));
  assert.ok(Number.isFinite(jita.mapPosition.y));
  assert.ok(result.mapNodes.some((node) => !node.isMonitored));
  assert.ok(result.connections.length > 0);
  assert.ok(
    result.connections.some(
      (connection) =>
        connection.fromSolarSystemId === 30000142 ||
        connection.toSolarSystemId === 30000142,
    ),
  );
});

test("does not invent coordinates for systems outside the 2D New Eden map", () => {
  const result = loadSystemMonitoringMap({
    monitors: [{ solarSystemId: 31000005, solarSystemName: "J123450" }],
  });
  assert.equal(result.positions.has(31000005), false);
  assert.deepEqual(result.mapNodes, []);
  assert.deepEqual(result.connections, []);
});
