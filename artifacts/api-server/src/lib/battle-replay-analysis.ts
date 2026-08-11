import {
  battleReportReviewsTable,
  db,
  type BattleReplayAnalysis,
  type BattleReplayKeyEvent,
  type BattleReplayLossPeak,
  type BattleReplayPhase,
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
    evidenceLevel: "confirmed",
    evidence: `击杀邮件 ${killmail.killmailId} 确认 ${killmail.victimShipName ?? "未知舰船"} 于 ${killmail.killmailTime.toISOString()} 被击毁。`,
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
      evidenceLevel: "confirmed",
      evidence: `该时间窗口包含击杀邮件 ${events.map((event) => event.killmailId).join("、")}。`,
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

function buildBattlePhases(
  report: ReportDetail,
  peaks: BattleReplayLossPeak[],
): BattleReplayPhase[] {
  const chronological = [...report.killmails].sort(
    (left, right) => left.killmailTime.getTime() - right.killmailTime.getTime(),
  );
  if (chronological.length === 0) return [];

  const first = chronological[0];
  const last = chronological.at(-1)!;
  const openingEndIndex = Math.min(
    chronological.length - 1,
    Math.max(0, Math.ceil(chronological.length * 0.25) - 1),
  );
  const openingEvents = chronological.slice(0, openingEndIndex + 1);
  const escalationEvents = chronological.slice(openingEndIndex + 1);
  const phases: BattleReplayPhase[] = [];

  if (report.startedAt.getTime() < first.killmailTime.getTime()) {
    phases.push({
      id: "contact",
      kind: "contact",
      startedAt: report.startedAt.toISOString(),
      endedAt: first.killmailTime.toISOString(),
      title: "接敌与首个公开损失",
      summary: `舰队开始后，首条匹配击杀记录出现在 ${first.killmailTime.toISOString()}。`,
      evidence:
        "击杀邮件只能确认首个损失时间，无法证明此前的移动、锁定或指挥过程。",
      evidenceLevel: "inferred",
      confidence: 0.55,
      relatedKillmailIds: [first.killmailId],
    });
  }

  phases.push({
    id: "opening",
    kind: "opening",
    startedAt: first.killmailTime.toISOString(),
    endedAt: openingEvents.at(-1)!.killmailTime.toISOString(),
    title: "第一轮交火",
    summary: `开场阶段记录 ${openingEvents.length} 次损失，本方 ${openingEvents.filter((event) => event.victimIsFleetMember).length} 艘、敌方 ${openingEvents.filter((event) => !event.victimIsFleetMember).length} 艘。`,
    evidence: `关联击杀邮件 ${openingEvents.map((event) => event.killmailId).join("、")}。`,
    evidenceLevel: "confirmed",
    confidence: 0.94,
    relatedKillmailIds: openingEvents.map((event) => event.killmailId),
  });

  if (escalationEvents.length > 0) {
    phases.push({
      id: "escalation",
      kind: "escalation",
      startedAt: escalationEvents[0].killmailTime.toISOString(),
      endedAt: last.killmailTime.toISOString(),
      title: "持续交火",
      summary: `后续阶段记录 ${escalationEvents.length} 次损失，本方 ${escalationEvents.filter((event) => event.victimIsFleetMember).length} 艘、敌方 ${escalationEvents.filter((event) => !event.victimIsFleetMember).length} 艘。`,
      evidence: `关联 ${escalationEvents.length} 条公开击杀邮件。`,
      evidenceLevel: "confirmed",
      confidence: 0.92,
      relatedKillmailIds: escalationEvents.map((event) => event.killmailId),
    });
  }

  const primaryPeak = [...peaks].sort(
    (left, right) =>
      right.killmailIds.length - left.killmailIds.length ||
      right.totalValue - left.totalValue,
  )[0];
  if (primaryPeak) {
    phases.push({
      id: "turning-point",
      kind: "turning_point",
      startedAt: primaryPeak.startedAt,
      endedAt: primaryPeak.endedAt,
      title: "战损高峰与潜在转折",
      summary: primaryPeak.reason,
      evidence:
        primaryPeak.evidence ??
        `关联击杀邮件 ${primaryPeak.killmailIds.join("、")}。`,
      evidenceLevel: "confirmed",
      confidence: primaryPeak.confidence,
      relatedKillmailIds: primaryPeak.killmailIds,
    });
  }

  if (last.killmailTime.getTime() < report.endedAt.getTime()) {
    phases.push({
      id: "extraction",
      kind: "extraction",
      startedAt: last.killmailTime.toISOString(),
      endedAt: report.endedAt.toISOString(),
      title: "脱离或战斗结束",
      summary: "最后一条公开损失记录至舰队结束之间没有新的匹配击杀邮件。",
      evidence: "该阶段可能是撤离、追击或停火；公开击杀数据无法区分具体行动。",
      evidenceLevel: "inferred",
      confidence: 0.45,
      relatedKillmailIds: [last.killmailId],
    });
  }

  return phases.sort(
    (left, right) =>
      new Date(left.startedAt).getTime() - new Date(right.startedAt).getTime(),
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
        "把这个 60 秒窗口作为战术复核点，确定下一次出现连续损失时由谁、在什么阈值下发出转火或脱离指令。",
      confidence: 0.82,
      relatedKillmailIds: worstFriendlyPeak.killmailIds,
      priority: worstFriendlyPeak.friendlyLosses >= 3 ? "critical" : "high",
      timeWindow: `${worstFriendlyPeak.startedAt} — ${worstFriendlyPeak.endedAt}`,
      actionSteps: [
        "由 FC 在复盘中对齐该窗口前后各 90 秒的语音、目标广播和锚点记录。",
        "按时间标出本方连续损失的第一艘、第二艘及当时仍在输出的敌方舰船，确认是否存在可提前识别的共同威胁。",
        "为下一次行动写入明确触发器：30 秒内出现 2 艘本方损失且没有敌方损失时，FC 必须在 10 秒内宣布继续接战、换目标或脱离三者之一。",
      ],
      successMetric:
        "下一次触发同类条件时，10 秒内有明确决策记录；决策后 60 秒内新增本方损失不超过 1 艘。",
      verifyWith: ["FC 语音时间轴", "目标广播记录", "锚点或舰队位置记录"],
    });
  }

  const logisticsLosses = report.killmails
    .filter(
      (killmail) =>
        killmail.victimIsFleetMember &&
        criticalShipScore(killmail.victimShipName) > 0,
    )
    .sort(
      (left, right) =>
        left.killmailTime.getTime() - right.killmailTime.getTime(),
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
        "为已损失的关键岗位逐舰建立保护检查表，并在战前指定锚点、预警广播和受压后的脱离动作。",
      confidence: 0.74,
      relatedKillmailIds: logisticsLosses.map(
        (killmail) => killmail.killmailId,
      ),
      priority: logisticsLosses.length >= 2 ? "critical" : "high",
      timeWindow: `${logisticsLosses[0].killmailTime.toISOString()} — ${logisticsLosses.at(-1)!.killmailTime.toISOString()}`,
      actionSteps: [
        `逐条复核 ${logisticsLosses.map((killmail) => killmail.victimShipName ?? "未知舰船").join("、")} 损失前 60 秒内的敌方攻击者、广播与锚点距离。`,
        "战前简报为后勤、指挥、拦截和电子战岗位分别指定主锚点与受压后的备用落点，禁止仅用“跟好锚”作为说明。",
        "约定关键舰被黄框或受到首轮伤害后 5 秒内广播；FC 在 10 秒内明确给出清除威胁、调整距离或关键舰脱离之一。",
      ],
      successMetric:
        "后续两次同编制行动中，关键职能舰在开场 5 分钟内损失为 0，受压广播到处置指令不超过 10 秒。",
      verifyWith: ["受压广播记录", "锚点距离或录屏", "FC 语音时间轴"],
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
    const threatEvents = report.killmails
      .filter((killmail) => leadingThreat.killmailIds.has(killmail.killmailId))
      .sort((left, right) => left.killmailTime.getTime() - right.killmailTime.getTime());
    suggestions.push({
      category: "target_calling",
      title: "复查对敌方高威胁舰船的识别与处理",
      observation: `${leadingThreat.pilotName ?? "未知飞行员"} 驾驶 ${leadingThreat.shipName ?? "未知舰船"}，参与 ${leadingThreat.killmailIds.size} 次本方损失并取得 ${leadingThreat.finalBlows} 次最后一击。`,
      evidence: `攻击者快照记录累计伤害 ${Math.round(leadingThreat.damageDone).toLocaleString()}，关联击杀邮件 ${[...leadingThreat.killmailIds].join("、")}。`,
      recommendation:
        "把该舰型写入下次战前威胁表，并为再次出现时预设优先处理、电子战压制或保持距离的触发条件。",
      confidence: 0.86,
      relatedKillmailIds: [...leadingThreat.killmailIds],
      priority: leadingThreat.killmailIds.size >= 3 ? "critical" : "high",
      timeWindow: `${threatEvents[0].killmailTime.toISOString()} — ${threatEvents.at(-1)!.killmailTime.toISOString()}`,
      actionSteps: [
        `由目标指挥在战前简报中标记 ${leadingThreat.shipName ?? "该类舰船"}，并说明其已关联 ${leadingThreat.killmailIds.size} 次本方损失。`,
        "在总览和广播标签中预设该舰型；同类舰船在 60 秒内参与第 2 次本方损失时，立即升级为高威胁目标。",
        "FC 必须在升级后 10 秒内选择集火、电子战压制或拉开距离，并在战后记录选择及结果。",
      ],
      successMetric:
        "下一次遭遇同类舰船时，第二次本方损失发生前完成威胁标记；升级后 10 秒内有明确处置记录。",
      verifyWith: ["侦察报告", "目标广播记录", "电子战或伤害日志"],
    });
  }

  if (report.friendlyLosses > report.hostileLosses) {
    suggestions.push({
      category: "target_calling",
      title: "复查目标选择和火力集中效率",
      observation: `本方损失 ${report.friendlyLosses} 艘，敌方损失 ${report.hostileLosses} 艘。`,
      evidence: `报告记录摧毁 ${Math.round(report.totalDestroyed).toLocaleString()} ISK，损失 ${Math.round(report.totalLost).toLocaleString()} ISK。`,
      recommendation:
        "用本次时间线计算每个敌方击杀之间的间隔，并为下一次行动设置目标切换和放弃目标的统一门槛。",
      confidence: 0.7,
      relatedKillmailIds: report.killmails
        .slice(0, 8)
        .map((killmail) => killmail.killmailId),
      priority: "high",
      timeWindow: `${report.startedAt.toISOString()} — ${report.endedAt.toISOString()}`,
      actionSteps: [
        "由目标指挥按时间线列出每次敌方损失前的主目标广播、参与人数和击杀间隔。",
        "找出最长的两个无敌方击杀区间，结合广播记录确认是目标过硬、火力分散还是频繁换目标；无记录时标记为待验证，不作事实判断。",
        "下次行动约定目标在 20 秒内无明显进展时由目标指挥明确宣布继续压制或切换，避免成员自行分散火力。",
      ],
      successMetric:
        "下次同规模交战中，所有目标切换均有广播记录；连续 60 秒无敌方损失的区间较本次减少。",
      verifyWith: ["目标广播记录", "伤害日志", "FC 或目标指挥语音"],
    });
  }

  if (suggestions.length === 0) {
    suggestions.push({
      category: "tempo",
      title: "围绕首杀和战损峰值进行重点复盘",
      observation: "当前公开击杀数据未显示单一明显失误模式。",
      evidence: `共匹配 ${report.killmailCount} 条击杀记录，建议结合指挥语音确认上下文。`,
      recommendation:
        "按固定顺序复查首个本方损失、最高价值事件和最密集交战窗口，形成下次行动前可检查的三条规则。",
      confidence: 0.58,
      relatedKillmailIds: report.killmails
        .slice(0, 5)
        .map((killmail) => killmail.killmailId),
      priority: "medium",
      timeWindow: `${report.startedAt.toISOString()} — ${report.endedAt.toISOString()}`,
      actionSteps: [
        "复核首个本方损失前后各 60 秒，记录当时已确认的敌方舰型和目标广播。",
        "复核最高价值击杀，记录参与人数、最后一击与从首条相关记录到击杀的耗时。",
        "选择击杀记录最密集的 60 秒，让 FC 为该窗口写出一条应保留做法和一条下次要改变的触发规则。",
      ],
      successMetric:
        "复盘结束时形成至少 3 条带触发条件、责任岗位和验证方式的战前规则。",
      verifyWith: ["击杀邮件时间线", "目标广播记录", "FC 补充说明"],
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
  const phases = buildBattlePhases(report, lossPeaks);
  const worstFriendlyPeak = [...lossPeaks].sort(
    (left, right) =>
      right.friendlyLosses - left.friendlyLosses ||
      right.totalValue - left.totalValue,
  )[0];
  const highestValueEvent = [...chronological].sort(
    (left, right) => right.totalValue - left.totalValue,
  )[0];
  const total = report.totalDestroyed + report.totalLost;
  const efficiency =
    total > 0 ? Math.round((report.totalDestroyed / total) * 1000) / 10 : 0;

  return {
    version: 1,
    source: "rules",
    model: "evidence-rules-v2",
    generatedAt: new Date().toISOString(),
    summary: `本次行动匹配 ${report.killmailCount} 条击杀记录，本方损失 ${report.friendlyLosses} 艘、敌方损失 ${report.hostileLosses} 艘，ISK 战斗效率约 ${efficiency}%。${worstFriendlyPeak ? `最需复核的损失窗口为 ${worstFriendlyPeak.startedAt} 至 ${worstFriendlyPeak.endedAt}，60 秒内本方损失 ${worstFriendlyPeak.friendlyLosses} 艘。` : "未检测到至少两条击杀记录构成的 60 秒战损高峰。"}${highestValueEvent ? `最高价值事件是 ${highestValueEvent.victimShipName ?? "未知舰船"} 损失，约 ${Math.round(highestValueEvent.totalValue).toLocaleString()} ISK（击杀邮件 ${highestValueEvent.killmailId}）。` : ""}`,
    keyShips,
    keyKills,
    lossPeaks,
    suggestions: buildRuleSuggestions(report, lossPeaks),
    phases,
    dataQuality: {
      confirmedEventCount: report.killmails.length,
      inferredEventCount: phases.filter(
        (phase) => phase.evidenceLevel === "inferred",
      ).length,
      limitations: [
        "公开击杀邮件不记录远程维修量，因此未出现在攻击或损失记录中的后勤舰无法确认。",
        "攻击者伤害只能证明参与和伤害占比，不能还原真实开火顺序、锁定、站位或移动轨迹。",
        "未造成伤害且未被击毁的敌方舰船不会出现在本次公开证据中。",
      ],
    },
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
            "priority",
            "timeWindow",
            "actionSteps",
            "successMetric",
            "verifyWith",
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
            priority: {
              type: "string",
              enum: ["critical", "high", "medium"],
            },
            timeWindow: { type: "string" },
            actionSteps: {
              type: "array",
              minItems: 3,
              maxItems: 5,
              items: { type: "string" },
            },
            successMetric: { type: "string" },
            verifyWith: {
              type: "array",
              minItems: 1,
              maxItems: 4,
              items: { type: "string" },
            },
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
          "你是 EVE Online 舰队战术复盘分析员。只使用提供的击杀邮件证据，用简体中文输出。summary 必须在 4 句内写出战损效率、最重要的损失窗口、最显著的敌方威胁和首要改进目标。识别关键舰船、关键击杀、60 秒战损高峰，并结合 attackerEvidence 与 enemyComposition 分析敌方舰船构成、参与击杀次数、伤害和最后一击集中度。每条 suggestion 必须对应至少一个输入 killmailId；observation 只写已确认现象，evidence 必须包含具体 UTC 时间、舰船或攻击者和数值，不能只写“数据表明”。recommendation 不得只写“加强、优化、注意、复查”；actionSteps 必须有 3 至 5 个可执行步骤，逐步写明负责岗位、触发条件或完成时限；successMetric 必须可量化；verifyWith 必须列出击杀邮件之外仍需核对的记录。priority 只按战损影响选择 critical、high 或 medium。keyShips 与 keyKills 必须标注该 killmail 中被击毁的舰船；敌方攻击舰船应写入建议的观察与证据。击杀邮件不记录远程维修量：未攻击且未被击毁的后勤舰不得描述为已确认存在。不能从数据证明的指挥、站位、语音、维修或移动情况必须表述为待复查或推测，禁止指责个人。所有引用的 killmailId 必须来自输入。",
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
            durationMinutes: Math.max(
              1,
              Math.round(
                (report.endedAt.getTime() - report.startedAt.getTime()) /
                  60_000,
              ),
            ),
          },
          events,
          enemyComposition,
          confirmedLossPeaks: detectLossPeaks(report.killmails),
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
              evidenceLevel: "confirmed" as const,
              evidence: `该窗口由击杀邮件 ${killmails.map((killmail) => killmail.killmailId).join("、")} 确认。`,
            },
          ];
        })
        .slice(0, 5)
    : [];
  const modelSuggestions = Array.isArray(modelAnalysis.suggestions)
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
          priority: ["critical", "high", "medium"].includes(
            suggestion.priority ?? "",
          )
            ? suggestion.priority
            : ("medium" as const),
          timeWindow:
            typeof suggestion.timeWindow === "string"
              ? suggestion.timeWindow.slice(0, 300)
              : "未提供具体时间窗口",
          actionSteps: Array.isArray(suggestion.actionSteps)
            ? suggestion.actionSteps
                .filter((step) => typeof step === "string" && step.trim())
                .map((step) => step.slice(0, 700))
                .slice(0, 5)
            : [],
          successMetric:
            typeof suggestion.successMetric === "string"
              ? suggestion.successMetric.slice(0, 700)
              : "由 FC 在复盘后补充量化验收标准。",
          verifyWith: Array.isArray(suggestion.verifyWith)
            ? suggestion.verifyWith
                .filter((item) => typeof item === "string" && item.trim())
                .map((item) => item.slice(0, 200))
                .slice(0, 4)
            : [],
        }))
        .filter((suggestion) =>
          suggestion.relatedKillmailIds.length > 0
          && suggestion.actionSteps.length >= 3
          && suggestion.actionSteps.some((step) => /\d|秒|分钟|小时|FC|指挥|后勤|目标/.test(step))
          && /\d|%/.test(suggestion.evidence)
          && /\d|%/.test(suggestion.successMetric)
        )
        .slice(0, 6)
    : [];
  const seenSuggestions = new Set<string>();
  const suggestions = [...modelSuggestions, ...fallback.suggestions]
    .filter((suggestion) => {
      const key = `${suggestion.category}:${suggestion.title}`;
      if (seenSuggestions.has(key)) return false;
      seenSuggestions.add(key);
      return true;
    })
    .slice(0, 6);

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
    suggestions,
    phases: fallback.phases,
    dataQuality: fallback.dataQuality,
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
