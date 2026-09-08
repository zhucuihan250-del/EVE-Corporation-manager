import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyShipGroups,
  countPlayerKills,
  extractR2Z2Killmail,
  highestSeverity,
  intelDedupeKey,
  killmailAffectsSystemRisk,
  messageContainsSystem,
  parseIntelMessage,
} from "./system-monitoring-rules";

const monitors = [
  { id: 1, solarSystemId: 30004759, solarSystemName: "1DQ1-A" },
  { id: 2, solarSystemId: 30000142, solarSystemName: "Jita" },
];

test("parses structured Chinese hostile intel", () => {
  const parsed = parseIntelMessage(
    "!intel 1DQ1-A +12 敌对 重拦+战列 向T5ZI-S ttl=20",
    monitors,
  );
  assert.ok(parsed);
  assert.equal(parsed.monitor.solarSystemId, 30004759);
  assert.equal(parsed.enemyCount, 12);
  assert.deepEqual(parsed.shipTags, ["泡泡船", "战列舰"]);
  assert.equal(parsed.direction, "T5ZI-S");
  assert.equal(parsed.ttlMinutes, 20);
  assert.equal(parsed.severity, "danger");
});

test("does not match a solar system inside a longer token", () => {
  assert.equal(
    messageContainsSystem("NOTJitaX is not a system report", "Jita"),
    false,
  );
  assert.equal(
    parseIntelMessage("normal channel conversation", monitors),
    null,
  );
});

test("normalizes duplicate message keys", () => {
  assert.equal(
    intelDedupeKey(["channel", "Pilot", "  JITA +5  "]),
    intelDedupeKey(["CHANNEL", "pilot", "jita +5"]),
  );
});

test("classifies special ship groups and risk", () => {
  assert.deepEqual(classifyShipGroups([898, 894]), {
    capital: false,
    blackOps: true,
    interdictor: true,
  });
  assert.equal(highestSeverity(["warning", "critical", "danger"]), "critical");
  assert.equal(highestSeverity([]), "safe");
  assert.equal(classifyShipGroups([4594]).capital, true);
  assert.equal(classifyShipGroups([5120]).capital, true);
});

test("extracts the current R2Z2 esi payload and keeps zKillboard value", () => {
  assert.deepEqual(
    extractR2Z2Killmail({
      killmail_id: 138223319,
      esi: {
        killmail_id: 138223319,
        killmail_time: "2026-09-05T03:00:00Z",
        solar_system_id: 30000142,
        victim: {
          character_id: 90000001,
          corporation_id: 1001,
          ship_type_id: 587,
        },
        attackers: [{ ship_type_id: 22436 }],
      },
      zkb: { totalValue: 1_250_000_000, npc: false },
    }),
    {
      killmail_id: 138223319,
      killmail_time: "2026-09-05T03:00:00Z",
      solar_system_id: 30000142,
      victim: {
        character_id: 90000001,
        corporation_id: 1001,
        ship_type_id: 587,
      },
      attackers: [{ ship_type_id: 22436 }],
      zkb: { totalValue: 1_250_000_000, npc: false },
    },
  );
});

test("NPC kills never affect monitored-system risk", () => {
  assert.equal(
    killmailAffectsSystemRisk({
      zkb: { npc: true, totalValue: 5_000_000_000 },
    }),
    false,
  );
  assert.equal(killmailAffectsSystemRisk({ zkb: { npc: false } }), true);
  assert.equal(killmailAffectsSystemRisk({}), true);
  assert.equal(
    countPlayerKills({ shipKills: 2, podKills: 1, npcKills: 100_000 }),
    3,
  );
  assert.equal(
    countPlayerKills({ shipKills: 0, podKills: 0, npcKills: 100_000 }),
    0,
  );
});
