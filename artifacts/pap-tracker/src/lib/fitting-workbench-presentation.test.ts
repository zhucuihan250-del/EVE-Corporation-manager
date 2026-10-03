import assert from "node:assert/strict";
import { test } from "node:test";
import {
  emptyFit,
  firstEmptySlot,
  nextModuleState,
  parseLocalDraft,
  durationLabel,
} from "./fitting-workbench-presentation";
const EMP = 185;

test("module states cycle only through allowed states in either direction", () => {
  assert.equal(nextModuleState("online", "online"), "offline");
  assert.equal(nextModuleState("offline", "online", true), "online");
  assert.equal(nextModuleState("active", "overheated"), "overheated");
  assert.equal(nextModuleState("overheated", "overheated"), "offline");
  assert.equal(nextModuleState("active", "active", true), "online");
});

test("slot placement preserves empty holes and duplicate module instances", () => {
  const fit = emptyFit(587, "Rifter");
  fit.slots = [
    { rack: "high", index: 0, typeId: 2881, state: "online" },
    { rack: "high", index: 2, typeId: 2881, state: "active" },
  ];
  assert.equal(firstEmptySlot(fit, "high", 3), 1);
  assert.equal(firstEmptySlot(fit, "low", 0), null);
  assert.equal(parseLocalDraft(JSON.stringify(fit))?.slots.length, 2);
});

test("local drafts accept full canonical fits and reject corrupt entries before rendering", () => {
  const fit = emptyFit(587, "Fixture fit");
  fit.slots = [
    {
      rack: "high",
      index: 0,
      typeId: 2881,
      state: "active",
      chargeTypeId: EMP,
      chargeQuantity: 1000,
    },
  ];
  fit.drones = [{ typeId: 2456, quantity: 5, activeQuantity: 3 }];
  fit.cargo = [{ typeId: EMP, quantity: 1000000 }];
  fit.implants = [{ typeId: 9943 }];
  fit.skillProfile = { mode: "character", characterId: 20 };
  assert.deepEqual(parseLocalDraft(JSON.stringify(fit)), fit);
  for (const mutation of [
    { drones: [null] },
    { cargo: [null] },
    { implants: [null] },
    { boosters: "bad" },
    { drones: [{ typeId: 2456, quantity: 5, activeQuantity: 6 }] },
    { drones: [{ typeId: 2456, quantity: 1001, activeQuantity: 0 }] },
    { cargo: [{ typeId: EMP, quantity: 1000001 }] },
    { slots: [{ rack: "high", index: 0, typeId: 2881, state: "toString" }] },
    {
      slots: [
        {
          rack: "high",
          index: 0,
          typeId: 2881,
          state: "online",
          chargeQuantity: 2,
        },
      ],
    },
    { skillProfile: { mode: "character" } },
    { skillProfile: { mode: "invalid" } },
    { damageProfile: { em: 0, thermal: 0, kinetic: 0, explosive: 0 } },
    { damageProfile: { em: -1, thermal: 25, kinetic: 25, explosive: 25 } },
    { modeTypeId: -1 },
    { name: "Invalid\nname" },
    {
      cargo: Array.from({ length: 257 }, () => ({ typeId: EMP, quantity: 1 })),
    },
  ])
    assert.equal(
      parseLocalDraft(JSON.stringify({ ...fit, ...mutation })),
      null,
      JSON.stringify(mutation),
    );
});

test("metric duration handles missing values and rounds seconds safely", () => {
  assert.equal(durationLabel(null), "—");
  assert.equal(durationLabel(Infinity), "—");
  assert.equal(durationLabel(119.6), "2:00");
  assert.equal(durationLabel(-1), "0:00");
});
