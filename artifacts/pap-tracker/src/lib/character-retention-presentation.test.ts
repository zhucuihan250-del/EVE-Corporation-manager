import assert from "node:assert/strict";
import test from "node:test";
import { characterCorporationLabel, retentionDeadlineLabel } from "./character-retention-presentation.ts";

test("departed characters never present the former corporation as their current corporation", () => {
  assert.equal(characterCorporationLabel({ membershipStatus: "departed", corporationName: "Former Corp", actualCorporationId: 98 }, true), "当前军团 ID 98");
  assert.equal(characterCorporationLabel({ membershipStatus: "departed", corporationName: "Former Corp" }, false), "Current corporation unknown");
});
test("unknown or legacy membership is not displayed as a confirmed current membership", () => {
  assert.equal(characterCorporationLabel({ membershipStatus: "unknown", corporationName: "Old Corp" }, true), "军团身份待核验");
  assert.equal(characterCorporationLabel({ corporationName: "Old Corp" }, false), "Corporation membership not verified");
  assert.equal(characterCorporationLabel({ membershipStatus: "member", corporationName: "Home Corp" }, true), "Home Corp");
});
test("retention deadlines use explicit UTC and missing deadlines are not invented", () => {
  assert.equal(retentionDeadlineLabel("2027-01-10T10:30:00+10:30"), "2027-01-10 00:00 UTC");
  for (const value of [undefined, null, "", "invalid"]) assert.equal(retentionDeadlineLabel(value), null);
});
