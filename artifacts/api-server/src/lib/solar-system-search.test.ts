import assert from "node:assert/strict";
import test from "node:test";
import { searchSolarSystems } from "./solar-system-search";

test("finds 74L2-U from a partial 74L search", () => {
  assert.deepEqual(searchSolarSystems("74L", 5)[0], {
    solarSystemId: 30000827,
    solarSystemName: "74L2-U",
  });
});

test("search is case insensitive and ranks prefix matches first", () => {
  const results = searchSolarSystems("jit", 10);
  assert.equal(results[0]?.solarSystemName, "Jita");
  assert.ok(results.every((result) =>
    result.solarSystemName.toUpperCase().includes("JIT"),
  ));
});

test("short queries are ignored and result count is bounded", () => {
  assert.deepEqual(searchSolarSystems("7"), []);
  const broadResults = searchSolarSystems("J1", 100);
  assert.ok(broadResults.length > 0);
  assert.ok(broadResults.length <= 25);
});
