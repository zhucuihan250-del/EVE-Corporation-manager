import assert from "node:assert/strict";
import test from "node:test";
import { selectSiteCorporation, siteAllowsLogin, siteSessionAllowsActor } from "./single-corporation-rules";

const home = { id: 1001, isPrimary: true, isActive: true };
const foreign = { id: 2002, isPrimary: false, isActive: true };

test("explicit home ID takes precedence over primary flags", () => {
  assert.equal(selectSiteCorporation([home, foreign], " 2002 "), foreign);
});

test("missing configuration requires exactly one active primary, never the first visitor", () => {
  assert.equal(selectSiteCorporation([home, foreign], undefined), home);
  assert.equal(selectSiteCorporation([foreign], undefined), null);
  assert.equal(selectSiteCorporation([], undefined), null);
  assert.equal(selectSiteCorporation([{ ...home, isActive: false }], undefined), null);
  assert.equal(selectSiteCorporation([home, { ...foreign, isPrimary: true, isActive: false }], undefined), null);
});

test("invalid or absent explicit IDs fail closed without fallback", () => {
  for (const value of ["0", "-1", "1e3", "1001x", "1001.0", "9999", "9007199254740992"]) {
    assert.equal(selectSiteCorporation([home, foreign], value), null, value);
  }
  assert.equal(selectSiteCorporation([{ ...home, isActive: false }], "1001"), null);
});

test("only a verified home character may log in", () => {
  assert.equal(siteAllowsLogin(1001, 1001), true);
  assert.equal(siteAllowsLogin(1001, 2002), false);
  assert.equal(siteAllowsLogin(1001, null), false);
  assert.equal(siteAllowsLogin(1001, 0), false);
});

test("session identity, ownership, corporation and deletion are all checked", () => {
  const input = {
    siteCorporationId: 1001, sessionCorporationId: 1001, sessionCharacterId: 101,
    userId: 1, actor: { userId: 1, corporationId: 1001, eveCharacterId: 101, deletedAt: null },
  };
  assert.equal(siteSessionAllowsActor(input), true);
  assert.equal(siteSessionAllowsActor({ ...input, sessionCorporationId: undefined }), true);
  assert.equal(siteSessionAllowsActor({ ...input, actor: null }), false);
  assert.equal(siteSessionAllowsActor({ ...input, sessionCorporationId: 2002 }), false);
  assert.equal(siteSessionAllowsActor({ ...input, sessionCorporationId: 0 }), false);
  assert.equal(siteSessionAllowsActor({ ...input, sessionCharacterId: 999 }), false);
  assert.equal(siteSessionAllowsActor({ ...input, sessionCharacterId: 0 }), false);
  assert.equal(siteSessionAllowsActor({ ...input, actor: { ...input.actor, userId: 2 } }), false);
  assert.equal(siteSessionAllowsActor({ ...input, actor: { ...input.actor, corporationId: 2002 } }), false);
  assert.equal(siteSessionAllowsActor({ ...input, actor: { ...input.actor, deletedAt: new Date() } }), false);
});
