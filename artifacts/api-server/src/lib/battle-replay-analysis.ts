import {
  battleReportReviewsTable,
  db,
  type BattleReplayAnalysis,
  type BattleReplayKeyEvent,
  type BattleReplayLossPeak,
  type BattleReplaySuggestion,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { loadBattleReportDetail } from "./battle-report-data";
import { logger } from "./logger";

type ReportDetail = NonNullable<
  Awaited<ReturnType<typeof loadBattleReportDetail>>
>;
type Killmail = ReportDetail["killmails"][number];

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_OPENAI_MODEL = "gpt-5.6";
const activeAnalysisJobs = new Set<number>();

const CRITICAL_SHIP_KEYWORDS = [
  "guardian",
  "basilisk",
  "scimitar",
  "oneiros",
  "zarmazd",
  "nestor",
  "monitor",
  "damnation",
  "vulture",
  "claymore",
  "nighthawk",
  "sleipnir",
  "sabre",
  "flycatcher",
  "heretic",
  "eris",
  "onyx",
  "broadsword",
  "devoter",
  "phobos",
  "apostle",
  "minokawa",
  "lif",
  "ninazu",
  "fax",
  "force auxiliary",
  "rapier",
  "huginn",
  "lachesis",
  "rook",
  "falcon",
  "scorpion",
  "dictor",
  "interdictor",
  "command ship",
  "logistics",
];

function clampConfidence(value: unknown, fallback = 0.65): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.max(0, Math.min(1, numeric));
}

function criticalShipScore(shipName: string | null): number {
  const normalized = shipName?.toLowerCase() ?? "";
  return CRITICAL_SHIP_KEYWORDS.some((keyword) => normalized.includes(keyword))
    ? 4
    : 0;
}

function eventScore(
  killmail: Killmail,
  firstFriendlyLossId: number | null,
  firstHostileLossId: number | null,
): number {
  const valueScore = Math.log10(Math.max(1, killmail.totalValue)) / 2;
  const criticalScore = criticalShipScore(killmail.victimShipName);
  const firstScore =
    killmail.killmailId === firstFriendlyLossId ||
    killmail.killmailId === firstHostileLossId
      ? 3
      : 0;
  const focusScore = Math.min(3, killmail.friendlyAttackers / 5);
  return valueScore + criticalScore + firstScore + focusScore;
}

function eventReason(
  killmail: Killmail,
  firstFriendlyLossId: number | null,
  firstHostileLossId: number | null,
): string {
  const reasons: string[] = [];
  if (criticalShipScore(killmail.victimShipName) > 0)
    reasons.push("该舰船通常承担后勤、指挥、拦截或电子战等关键职责");
  if (killmail.killmailId === firstFriendlyLossId)
    reasons.push("这是舰队本方的首个损失");
  if (killmail.killmailId === firstHostileLossId)
    reasons.push("这是敌对方的首个损失");
  if (killmail.totalValue >= 1_000_000_000) reasons.push("损失价值较高");
  if (killmail.friendlyAttackers >= 5 && !killmail.victimIsFleetMember)
    reasons.push("本方多人同时参与攻击，可能是集火目标");
  return reasons.length > 0
    ? reasons.join("；")
    : "该事件在时间、价值或火力集中度上具有较高复盘价值";
}

function toKeyEvent(
  killmail: Killmail,
  title: string,
  reason: string,
  confidence: number,
): BattleReplayKeyEvent {
  return {
    killmailId: killmail.killmailId,
    occurredAt: killmail.killmailTime.toISOString(),
    title,
    reason,
    confidence: clampConfidence(confidence),
    shipName: killmail.victimShipName,
    pilotName: killmail.victimCharacterName,
    friendlyLoss: killmail.victimIsFleetMember,
    totalValue: killmail.totalValue,
  };
}

function detectLossPeaks(killmails: Killmail[]): BattleReplayLossPeak[] {
  const chronological = [...killmails].sort(
    (left, right) => left.killmailTime.getTime() - right.killmailTime.getTime(),
  );
  const candidates: BattleReplayLossPeak[] = [];

  for (let index = 0; index < chronological.length; index++) {
    const startedAt = chronological[index].killmailTime.getTime();
    const events = chronological.filter((event) => {
      const time = event.killmailTime.getTime();
      return time >= startedAt && time <= startedAt + 60_000;
    });
    if (events.length < 2) continue;

    const friendlyLosses = events.filter(
      (event) => event.victimIsFleetMember,
    ).length;
    const hostileLosses = events.length - friendlyLosses;
    const totalValue = events.reduce((sum, event) => sum + event.totalValue, 0);
    const endedAt = events.at(-1)!.killmailTime;
    candidates.push({
      startedAt: new Date(startedAt).toISOString(),
      endedAt: endedAt.toISOString(),
      title: `60 秒内发生 ${events.length} 次损失`,
      reason: `本方损失 ${friendlyLosses} 艘，敌方损失 ${hostileLosses} 艘，合计约 ${Math.round(totalValue).toLocaleString()} ISK`,
      confidence: 0.95,
      killmailIds: events.map((event) => event.killmailId),
      friendlyLosses,
      hostileLosses,
      totalValue,
    });
  }

  return candidates
    .sort(
      (left, right) =>
        right.killmailIds.length * 10 +
        Math.log10(Math.max(1, right.totalValue)) -
        (left.killmailIds.length * 10 +
          Math.log10(Math.max(1, left.totalValue))),
    )
    .filter((candidate, index, all) =>
      all.slice(0, index).every((picked) => {
        const start = new Date(candidate.startedAt).getTime();
        const pickedStart = new Date(picked.startedAt).getTime();
        return Math.abs(start - pickedStart) > 60_000;
      }),
    )
    .slice(0, 3)
    .sort(
      (left, right) =>
        new Date(left.startedAt).getTime() -
        new Date(right.startedAt).getTime(),
    );
}

function buildRuleSuggestions(
  report: ReportDetail,
  peaks: BattleReplayLossPeak[],
): BattleReplaySuggestion[] {
  const suggestions: BattleReplaySuggestion[] = [];
  const worstFriendlyPeak = [...peaks].sort(
    (left, right) => right.friendlyLosses - left.friendlyLosses,
  )[0];

  if (worstFriendlyPeak?.friendlyLosses) {
    suggestions.push({
      category: "extraction",
      title: "复查战损高峰前后的接战与撤离判断",
      observation: `${worstFriendlyPeak.friendlyLosses} 艘本方舰船在一个 60 秒窗口内损失。`,
      evidence: `时间 ${worstFriendlyPeak.startedAt} 至 ${worstFriendlyPeak.endedAt}，关联 ${worstFriendlyPeak.killmailIds.length} 条击杀记录。`,
      recommendation:
        "结合 FC 语音、锚点与广播记录，确认是否在该节点需要更早转火、拉开或撤离。",
      confidence: 0.82,
      relatedKillmailIds: worstFriendlyPeak.killmailIds,
    });
  }

  const logisticsLosses = report.killmails.filter(
    (killmail) =>
      killmail.victimIsFleetMember &&
      criticalShipScore(killmail.victimShipName) > 0,
  );
  if (logisticsLosses.length > 0) {
    suggestions.push({
      category: "logistics",
      title: "检查关键职能舰船的保护与站位",
      observation: `识别到 ${logisticsLosses.length} 艘可能承担后勤、指挥、拦截或电子战职责的本方舰船损失。`,
      evidence: logisticsLosses
        .map(
          (killmail) =>
            `${killmail.victimShipName ?? "未知舰船"} @ ${killmail.killmailTime.toISOString()}`,
        )
        .join("；"),
      recommendation:
        "复查关键舰船是否过早暴露、是否脱离锚点，以及舰队是否及时处理针对关键岗位的敌方火力。",
      confidence: 0.74,
      relatedKillmailIds: logisticsLosses.map(
        (killmail) => killmail.killmailId,
      ),
    });
  }

  const enemyThreats = [
    ...report.killmails
      .filter((killmail) => killmail.victimIsFleetMember)
      .reduce(
        (map, killmail) => {
          for (const attacker of killmail.attackers ?? []) {
            if (attacker.isFleetMember) continue;
            const key =
              attacker.characterId ??
              `${attacker.characterName ?? "unknown"}-${attacker.shipTypeId ?? "unknown"}`;
            const entry = map.get(key) ?? {
              pilotName: attacker.characterName,
              shipName: attacker.shipName,
              killmailIds: new Set<number>(),
              finalBlows: 0,
              damageDone: 0,
            };
            entry.killmailIds.add(killmail.killmailId);
            entry.finalBlows += Number(attacker.finalBlow);
            entry.damageDone += attacker.damageDone;
            map.set(key, entry);
          }
          return map;
        },
        new Map<
          number | string,
          {
            pilotName: string | null;
            shipName: string | null;
            killmailIds: Set<number>;
            finalBlows: number;
            damageDone: number;
          }
        >(),
      )
      .values(),
  ].sort(
    (left, right) =>
      right.finalBlows - left.finalBlows ||
      right.killmailIds.size - left.killmailIds.size ||
      right.damageDone - left.damageDone,
  );
  const leadingThreat = enemyThreats[0];
  if (
    leadingThreat &&
    (leadingThreat.finalBlows > 0 || leadingThreat.killmailIds.size > 1)
  ) {
    suggestions.push({
      category: "target_calling",
      title: "复查对敌方高威胁舰船的识别与处理",
      observation: `${leadingThreat.pilotName ?? "未知飞行员"} 驾驶 ${leadingThreat.shipName ?? "未知舰船"}，参与 ${leadingThreat.killmailIds.size} 次本方损失并取得 ${leadingThreat.finalBlows} 次最后一击。`,
      evidence: `攻击者快照记录累计伤害 ${Math.round(leadingThreat.damageDone).toLocaleString()}，关联击杀邮件 ${[...leadingThreat.killmailIds].join("、")}。`,
      recommendation:
        "结合现场侦察与广播记录，复查是否应更早标记、规避或优先处理该类高威胁舰船。",
      confidence: 0.86,
      relatedKillmailIds: [...leadingThreat.killmailIds],
    });
  }

  if (report.friendlyLosses > report.hostileLosses) {
    suggestions.push({
      category: "target_calling",
      title: "复查目标选择和火力集中效率",
      observation: `本方损失 ${report.friendlyLosses} 艘，敌方损失 ${report.hostileLosses} 艘。`,
      evidence: `报告记录摧毁 ${Math.round(report.totalDestroyed).toLocaleString()} ISK，损失 ${Math.round(report.totalLost).toLocaleString()} ISK。`,
      recommendation:
        "按时间线核对主目标广播和击杀间隔，确认是否存在火力分散或目标切换过频。",
      confidence: 0.7,
      relatedKillmailIds: report.killmails
        .slice(0, 8)
        .map((killmail) => killmail.killmailId),
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      category: "tempo",
      title: "围绕首杀和战损峰值进行重点复盘",
      observation: "当前公开击杀数据未显示单一明显失误模式。",
      evidence: `共匹配 ${report.killmailCount} 条击杀记录，建议结合指挥语音确认上下文。`,
      recommendation:
        "优先复查首个重要损失、最大价值击杀以及交战最密集的时间段。",
      confidence: 0.58,
      relatedKillmailIds: report.killmails
        .slice(0, 5)
        .map((killmail) => killmail.killmailId),
    });
  }

  return suggestions.slice(0, 5);
}

function buildRuleAnalysis(report: ReportDetail): BattleReplayAnalysis {
  const chronological = [...report.killmails].sort(
    (left, right) => left.killmailTime.getTime() - right.killmailTime.getTime(),
  );
  const firstFriendlyLossId =
    chronological.find((event) => event.victimIsFleetMember)?.killmailId ??
    null;
  const firstHostileLossId =
    chronological.find((event) => !event.victimIsFleetMember)?.killmailId ??
    null;
  const ranked = [...chronological].sort(
    (left, right) =>
      eventScore(right, firstFriendlyLossId, firstHostileLossId) -
      eventScore(left, firstFriendlyLossId, firstHostileLossId),
  );
  const keyShips = ranked
    .filter(
      (event) =>
        criticalShipScore(event.victimShipName) > 0 ||
        event.totalValue >= 1_000_000_000,
    )
    .slice(0, 5)
    .map((event) =>
      toKeyEvent(
        event,
        `${event.victimIsFleetMember ? "本方" : "敌方"}关键舰船：${event.victimShipName ?? "未知舰船"}`,
        eventReason(event, firstFriendlyLossId, firstHostileLossId),
        0.78,
      ),
    );
  const keyKills = ranked
    .slice(0, 6)
    .map((event) =>
      toKeyEvent(
        event,
        `${event.victimIsFleetMember ? "本方损失" : "敌方击杀"}：${event.victimShipName ?? "未知舰船"}`,
        eventReason(event, firstFriendlyLossId, firstHostileLossId),
        0.72,
      ),
    );
  const lossPeaks = detectLossPeaks(chronological);
  const total = report.totalDestroyed + report.totalLost;
  const efficiency =
    total > 0 ? Math.round((report.totalDestroyed / total) * 1000) / 10 : 0;

  return {
    version: 1,
    source: "rules",
    model: "evidence-rules-v1",
    generatedAt: new Date().toISOString(),
    summary: `本次行动匹配 ${report.killmailCount} 条击杀记录，本方损失 ${report.friendlyLosses} 艘，敌方损失 ${report.hostileLosses} 艘，战斗效率约 ${efficiency}%。系统已按舰船职责、损失价值、首个损失和火力集中度标记重点事件。`,
    keyShips,
    keyKills,
    lossPeaks,
    suggestions: buildRuleSuggestions(report, lossPeaks),
  };
}

type ModelEventAnnotation = {
  killmailId: number;
  title: string;
  reason: string;
  confidence: number;
};
type ModelPeakAnnotation = {
  killmailIds: number[];
  title: string;
  reason: string;
  confidence: number;
};
type ModelSuggestion = BattleReplaySuggestion;
type ModelAnalysis = {
  summary: string;
  keyShips: ModelEventAnnotation[];
  keyKills: ModelEventAnnotation[];
  lossPeaks: ModelPeakAnnotation[];
  suggestions: ModelSuggestion[];
};

function responseOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as { output_text?: unknown; output?: unknown };
  if (typeof response.output_text === "string") return response.output_text;
  if (!Array.isArray(response.output)) return null;
  for (const item of response.output) {
    if (
      !item ||
      typeof item !== "object" ||
      !Array.isArray((item as { content?: unknown }).content)
    )
      continue;
    for (const content of (item as { content: unknown[] }).content) {
      if (
        content &&
        typeof content === "object" &&
        typeof (content as { text?: unknown }).text === "string"
      ) {
        return (content as { text: string }).text;
      }
    }
  }
  return null;
}

async function requestOpenAiAnalysis(
  report: ReportDetail,
  userId: number,
): Promise<{ model: string; analysis: ModelAnalysis }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey)
    throw new Error(
      "OPENAI_API_KEY is not configured; deterministic analysis was used.",
    );
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const events = [...report.killmails]
    .sort(
      (left, right) =>
        left.killmailTime.getTime() - right.killmailTime.getTime(),
    )
    .slice(0, 150)
    .map((killmail) => ({
      killmailId: killmail.killmailId,
      time: killmail.killmailTime.toISOString(),
      side: killmail.victimIsFleetMember ? "friendly_loss" : "hostile_loss",
      victim: killmail.victimCharacterName,
      ship: killmail.victimShipName,
      system: killmail.solarSystemName,
      totalValue: Math.round(killmail.totalValue),
      friendlyDamage: Math.round(killmail.friendlyDamage),
      friendlyAttackers: killmail.friendlyAttackers,
      finalBlowByFleet: killmail.finalBlowByFleet,
      attackerEvidence: [...(killmail.attackers ?? [])]
        .filter((attacker) =>
          killmail.victimIsFleetMember
            ? !attacker.isFleetMember
            : attacker.isFleetMember,
        )
        .sort(
          (left, right) =>
            Number(right.finalBlow) - Number(left.finalBlow) ||
            right.damageDone - left.damageDone,
        )
        .slice(0, 25)
        .map((attacker) => ({
          side: attacker.isFleetMember ? "friendly" : "hostile",
          pilot: attacker.characterName,
          corporation: attacker.corporationName,
          alliance: attacker.allianceName,
          ship: attacker.shipName,
          damageDone: attacker.damageDone,
          finalBlow: attacker.finalBlow,
        })),
    }));
  const enemyComposition = [
    ...report.killmails
      .filter((killmail) => killmail.victimIsFleetMember)
      .reduce(
        (map, killmail) => {
          for (const attacker of killmail.attackers ?? []) {
            if (attacker.isFleetMember) continue;
            const key = attacker.shipTypeId ?? `unknown-${attacker.shipName}`;
            const entry = map.get(key) ?? {
              ship: attacker.shipName,
              pilots: new Set<string>(),
              killmailIds: new Set<number>(),
              finalBlows: 0,
              damageDone: 0,
            };
            entry.pilots.add(
              String(
                attacker.characterId ??
                  attacker.characterName ??
                  `npc-${attacker.shipTypeId ?? "unknown"}`,
              ),
            );
            entry.killmailIds.add(killmail.killmailId);
            entry.finalBlows += Number(attacker.finalBlow);
            entry.damageDone += attacker.damageDone;
            map.set(key, entry);
          }
          return map;
        },
        new Map<
          number | string,
          {
            ship: string | null;
            pilots: Set<string>;
            killmailIds: Set<number>;
            finalBlows: number;
            damageDone: number;
          }
        >(),
      )
      .values(),
  ]
    .sort(
      (left, right) =>
        right.killmailIds.size - left.killmailIds.size ||
        right.damageDone - left.damageDone,
    )
    .slice(0, 30)
    .map((entry) => ({
      ship: entry.ship,
      observedPilots: entry.pilots.size,
      killInvolvements: entry.killmailIds.size,
      finalBlows: entry.finalBlows,
      damageDone: entry.damageDone,
      relatedKillmailIds: [...entry.killmailIds],
    }));

  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "keyShips", "keyKills", "lossPeaks", "suggestions"],
    properties: {
      summary: { type: "string" },
      keyShips: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["killmailId", "title", "reason", "confidence"],
          properties: {
            killmailId: { type: "integer" },
            title: { type: "string" },
            reason: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      keyKills: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["killmailId", "title", "reason", "confidence"],
          properties: {
            killmailId: { type: "integer" },
            title: { type: "string" },
            reason: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      lossPeaks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["killmailIds", "title", "reason", "confidence"],
          properties: {
            killmailIds: { type: "array", items: { type: "integer" } },
            title: { type: "string" },
            reason: { type: "string" },
            confidence: { type: "number" },
          },
        },
      },
      suggestions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "category",
            "title",
            "observation",
            "evidence",
            "recommendation",
            "confidence",
            "relatedKillmailIds",
          ],
          properties: {
            category: {
              type: "string",
              enum: [
                "target_calling",
                "logistics",
                "positioning",
                "extraction",
                "fleet_composition",
                "tempo",
                "other",
              ],
            },
            title: { type: "string" },
            observation: { type: "string" },
            evidence: { type: "string" },
            recommendation: { type: "string" },
            confidence: { type: "number" },
            relatedKillmailIds: { type: "array", items: { type: "integer" } },
          },
        },
      },
    },
  };

  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        store: false,
        safety_identifier: `eve-pap-user-${userId}`,
        reasoning: { effort: "medium" },
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "eve_battle_review",
            strict: true,
            schema,
          },
        },
        instructions:
          "你是 EVE Online 舰队战斗复盘助手。只使用提供的击杀邮件证据，用简体中文输出。识别关键舰船、关键击杀、60 秒战损高峰，并结合 attackerEvidence 与 enemyComposition 分析敌方舰船构成、参与击杀次数、伤害和最后一击集中度，提供可执行建议。keyShips 与 keyKills 必须标注该 killmail 中被击毁的舰船；敌方攻击舰船应写入建议的观察与证据。不能从数据证明的指挥、站位、语音或移动情况必须表述为待复查或推测，禁止指责个人。所有引用的 killmailId 必须来自输入。",
        input: JSON.stringify({
          battle: {
            name: report.fleetName,
            commander: report.fleetCommander,
            startedAt: report.startedAt,
            endedAt: report.endedAt,
            primarySystem: report.primarySystemName,
            friendlyLosses: report.friendlyLosses,
            hostileLosses: report.hostileLosses,
            totalDestroyed: Math.round(report.totalDestroyed),
            totalLost: Math.round(report.totalLost),
          },
          events,
          enemyComposition,
        }),
      }),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 300);
      throw new Error(`OpenAI ${response.status}: ${body}`);
    }
    const outputText = responseOutputText(await response.json());
    if (!outputText)
      throw new Error("OpenAI response did not contain structured output.");
    return { model, analysis: JSON.parse(outputText) as ModelAnalysis };
  } finally {
    clearTimeout(timeout);
  }
}

function mergeModelAnalysis(
  report: ReportDetail,
  fallback: BattleReplayAnalysis,
  model: string,
  modelAnalysis: ModelAnalysis,
): BattleReplayAnalysis {
  const byId = new Map(
    report.killmails.map((killmail) => [killmail.killmailId, killmail]),
  );
  const validIds = new Set(byId.keys());
  const mapEvents = (
    annotations: ModelEventAnnotation[],
    fallbackEvents: BattleReplayKeyEvent[],
  ) => {
    const mapped = Array.isArray(annotations)
      ? annotations
          .flatMap((annotation) => {
            const killmail = byId.get(annotation.killmailId);
            if (!killmail) return [];
            return [
              toKeyEvent(
                killmail,
                annotation.title.slice(0, 160),
                annotation.reason.slice(0, 1_500),
                annotation.confidence,
              ),
            ];
          })
          .slice(0, 8)
      : [];
    return mapped.length > 0 ? mapped : fallbackEvents;
  };
  const lossPeaks = Array.isArray(modelAnalysis.lossPeaks)
    ? modelAnalysis.lossPeaks
        .flatMap((peak) => {
          const killmails = [...new Set(peak.killmailIds)].flatMap(
            (id) => byId.get(id) ?? [],
          );
          if (killmails.length < 2) return [];
          killmails.sort(
            (left, right) =>
              left.killmailTime.getTime() - right.killmailTime.getTime(),
          );
          return [
            {
              startedAt: killmails[0].killmailTime.toISOString(),
              endedAt: killmails.at(-1)!.killmailTime.toISOString(),
              title: peak.title.slice(0, 160),
              reason: peak.reason.slice(0, 1_500),
              confidence: clampConfidence(peak.confidence),
              killmailIds: killmails.map((killmail) => killmail.killmailId),
              friendlyLosses: killmails.filter(
                (killmail) => killmail.victimIsFleetMember,
              ).length,
              hostileLosses: killmails.filter(
                (killmail) => !killmail.victimIsFleetMember,
              ).length,
              totalValue: killmails.reduce(
                (sum, killmail) => sum + killmail.totalValue,
                0,
              ),
            },
          ];
        })
        .slice(0, 5)
    : [];
  const suggestions = Array.isArray(modelAnalysis.suggestions)
    ? modelAnalysis.suggestions
        .map((suggestion) => ({
          category: suggestion.category,
          title: suggestion.title.slice(0, 160),
          observation: suggestion.observation.slice(0, 2_000),
          evidence: suggestion.evidence.slice(0, 2_000),
          recommendation: suggestion.recommendation.slice(0, 2_000),
          confidence: clampConfidence(suggestion.confidence),
          relatedKillmailIds: [...new Set(suggestion.relatedKillmailIds)]
            .filter((id) => validIds.has(id))
            .slice(0, 20),
        }))
        .slice(0, 8)
    : [];

  return {
    version: 1,
    source: "openai",
    model,
    generatedAt: new Date().toISOString(),
    summary:
      typeof modelAnalysis.summary === "string"
        ? modelAnalysis.summary.slice(0, 3_000)
        : fallback.summary,
    keyShips: mapEvents(modelAnalysis.keyShips, fallback.keyShips),
    keyKills: mapEvents(modelAnalysis.keyKills, fallback.keyKills),
    lossPeaks: lossPeaks.length > 0 ? lossPeaks : fallback.lossPeaks,
    suggestions: suggestions.length > 0 ? suggestions : fallback.suggestions,
  };
}

async function runAnalysis(reportId: number, userId: number): Promise<void> {
  const report = await loadBattleReportDetail(reportId);
  if (!report) throw new Error("Battle report not found");
  const fallback = buildRuleAnalysis(report);
  let analysis = fallback;
  let providerError: string | null = null;

  if (report.killmails.length > 0) {
    try {
      const openai = await requestOpenAiAnalysis(report, userId);
      analysis = mergeModelAnalysis(
        report,
        fallback,
        openai.model,
        openai.analysis,
      );
    } catch (error) {
      providerError =
        error instanceof Error
          ? error.message.slice(0, 500)
          : "AI provider unavailable";
      logger.warn(
        { error, reportId },
        "OpenAI battle analysis unavailable; using evidence rules",
      );
    }
  }

  await db
    .update(battleReportReviewsTable)
    .set({
      aiStatus: "ready",
      aiSource: analysis.source,
      aiModel: analysis.model,
      aiError: providerError,
      aiAnalysis: analysis,
      aiAnalyzedAt: new Date(),
      updatedBy: userId,
      updatedAt: new Date(),
    })
    .where(eq(battleReportReviewsTable.battleReportId, reportId));
}

export async function queueBattleReplayAnalysis(
  reportId: number,
  userId: number,
): Promise<"queued" | "already_running"> {
  if (activeAnalysisJobs.has(reportId)) return "already_running";

  await db
    .insert(battleReportReviewsTable)
    .values({
      battleReportId: reportId,
      aiStatus: "generating",
      aiError: null,
      updatedBy: userId,
    })
    .onConflictDoUpdate({
      target: battleReportReviewsTable.battleReportId,
      set: {
        aiStatus: "generating",
        aiError: null,
        updatedBy: userId,
        updatedAt: new Date(),
      },
    });

  activeAnalysisJobs.add(reportId);
  void runAnalysis(reportId, userId)
    .catch(async (error) => {
      logger.error({ error, reportId }, "Battle replay analysis failed");
      await db
        .update(battleReportReviewsTable)
        .set({
          aiStatus: "failed",
          aiError:
            error instanceof Error
              ? error.message.slice(0, 500)
              : "Unknown analysis error",
          updatedAt: new Date(),
        })
        .where(eq(battleReportReviewsTable.battleReportId, reportId))
        .catch((updateError) =>
          logger.error(
            { updateError, reportId },
            "Failed to persist battle replay analysis error",
          ),
        );
    })
    .finally(() => activeAnalysisJobs.delete(reportId));

  return "queued";
}
