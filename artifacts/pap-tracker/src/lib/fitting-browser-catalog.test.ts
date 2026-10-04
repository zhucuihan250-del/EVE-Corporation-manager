import assert from "node:assert/strict";
import { test } from "node:test";
import { fittingBrowserCatalogQuery } from "./fitting-browser-catalog";

const context = {
  tab: "hardware" as const,
  query: "",
  category: "module" as const,
  rack: "all" as const,
  language: "zh",
  shipTypeId: 587,
};

test("hardware searches are bound to the active hull, including cache identity", () => {
  const rifter = fittingBrowserCatalogQuery(context);
  const raven = fittingBrowserCatalogQuery({ ...context, shipTypeId: 638 });
  assert.equal(rifter.enabled, true);
  assert.equal(rifter.options.shipTypeId, 587);
  assert.equal(rifter.options.subsystemTypeIds, "");
  assert.notDeepEqual(rifter.queryKey, raven.queryKey);
  assert.equal(rifter.queryKey[2], rifter.options);
});

test("hardware cannot fall back to an unfiltered catalog before a hull is selected", () => {
  for (const shipTypeId of [0, -1, Number.NaN, 1.5]) {
    const query = fittingBrowserCatalogQuery({ ...context, shipTypeId });
    assert.equal(query.enabled, false);
    assert.equal(query.options.shipTypeId, undefined);
  }
});

test("hull and saved tabs do not inherit hardware compatibility restrictions", () => {
  const hulls = fittingBrowserCatalogQuery({
    ...context,
    tab: "ships",
    shipTypeId: 0,
    category: "charge",
    rack: "high",
    selectedTypeId: 2881,
    subsystemTypeIds: [4567],
  });
  assert.equal(hulls.enabled, true);
  assert.equal(hulls.options.category, "ship");
  assert.equal(hulls.options.slot, "all");
  assert.equal(hulls.options.shipTypeId, undefined);
  assert.equal(hulls.options.chargeForTypeId, undefined);
  assert.equal(hulls.options.subsystemTypeIds, undefined);
  assert.equal(fittingBrowserCatalogQuery({ ...context, tab: "saved" }).enabled, false);
});

test("rack and search changes update the catalog without removing hull context", () => {
  const high = fittingBrowserCatalogQuery({ ...context, rack: "high", query: "炮" });
  const low = fittingBrowserCatalogQuery({ ...context, rack: "low", query: "炮" });
  assert.equal(high.options.slot, "high");
  assert.equal(high.options.q, "炮");
  assert.equal(high.options.shipTypeId, context.shipTypeId);
  assert.notDeepEqual(high.queryKey, low.queryKey);
});

test("subsystem category always uses the subsystem rack, not a stale module rack", () => {
  const query = fittingBrowserCatalogQuery({
    ...context,
    category: "subsystem",
    rack: "low",
  });
  assert.equal(query.options.slot, "subsystem");
});

test("charges are narrowed to the selected module and refresh when that module changes", () => {
  const turret = fittingBrowserCatalogQuery({
    ...context,
    category: "charge",
    selectedTypeId: 2881,
  });
  const launcher = fittingBrowserCatalogQuery({
    ...context,
    category: "charge",
    selectedTypeId: 10629,
  });
  assert.equal(turret.options.chargeForTypeId, 2881);
  assert.equal(turret.options.slot, "all");
  assert.notDeepEqual(turret.queryKey, launcher.queryKey);
  assert.equal(
    fittingBrowserCatalogQuery({ ...context, category: "charge" }).options.chargeForTypeId,
    undefined,
  );
  assert.equal(
    fittingBrowserCatalogQuery({ ...context, selectedTypeId: 2881 }).options.chargeForTypeId,
    undefined,
  );
});

test("T3 subsystem changes refresh eligibility, while slot reordering keeps the same context", () => {
  const first = fittingBrowserCatalogQuery({ ...context, subsystemTypeIds: [4567, 1234] });
  const reordered = fittingBrowserCatalogQuery({ ...context, subsystemTypeIds: [1234, 4567] });
  const removed = fittingBrowserCatalogQuery({ ...context, subsystemTypeIds: [1234] });
  assert.equal(first.options.subsystemTypeIds, "1234,4567");
  assert.deepEqual(first.queryKey, reordered.queryKey);
  assert.notDeepEqual(first.queryKey, removed.queryKey);
});

test("pilot supplies and cargo retain hull context but never inherit weapon or rack filters", () => {
  for (const category of ["implant", "booster", "cargo", "drone", "fighter"] as const) {
    const query = fittingBrowserCatalogQuery({ ...context, category, rack: "high", selectedTypeId: 2881 });
    assert.equal(query.options.shipTypeId, context.shipTypeId);
    assert.equal(query.options.slot, "all");
    assert.equal(query.options.chargeForTypeId, undefined);
  }
});
