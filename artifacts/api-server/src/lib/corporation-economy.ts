import {
  corporationWalletBalancesTable,
  corporationWalletConnectionsTable,
  corporationWalletEntriesTable,
  db,
  economyAnalysesTable,
  reimbursementClaimsTable,
} from "@workspace/db";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { refreshAccessToken } from "./eve-sso";

const ESI_BASE = "https://esi.evetech.net/latest";
const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_MODEL = "gpt-5.6";

type WalletJournalEntry = {
  id: number;
  date: string;
  ref_type: string;
  amount: number;
  balance?: number;
  first_party_id?: number;
  second_party_id?: number;
  reason?: string;
  [key: string]: unknown;
};

export type EconomyAction = {
  title: string;
  evidence: string;
  owner: string;
  steps: string[];
  startupCost: number;
  timeToImpactDays: number;
  expectedMonthlyGain: number;
  kpi: string;
  risk: string;
  confidence: number;
};

export type EconomyAnalysis = {
  source: "openai" | "rules";
  model: string;
  generatedAt: string;
  summary: string;
  actions: EconomyAction[];
};

function monthStart(offset = 0): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
}

async function authorizedWalletToken(corporationId: number): Promise<string> {
  const [connection] = await db
    .select()
    .from(corporationWalletConnectionsTable)
    .where(eq(corporationWalletConnectionsTable.corporationId, corporationId));
  if (!connection) throw new Error("CORPORATION_WALLET_NOT_CONNECTED");

  if (connection.tokenExpiry.getTime() > Date.now() + 60_000) {
    return connection.accessToken;
  }
  try {
    const refreshed = await refreshAccessToken(connection.refreshToken);
    const tokenExpiry = new Date(Date.now() + refreshed.expiresIn * 1000);
    await db.update(corporationWalletConnectionsTable).set({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      tokenExpiry,
      status: "connected",
      lastError: null,
    }).where(eq(corporationWalletConnectionsTable.corporationId, corporationId));
    return refreshed.accessToken;
  } catch (error) {
    await db.update(corporationWalletConnectionsTable).set({
      status: "error",
      lastError: error instanceof Error ? error.message.slice(0, 1_000) : "Token refresh failed",
    }).where(eq(corporationWalletConnectionsTable.corporationId, corporationId));
    throw error;
  }
}

async function esiFetch<T>(url: string, accessToken: string): Promise<{ data: T; pages: number }> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`EVE ESI ${response.status}: ${body}`);
  }
  return {
    data: (await response.json()) as T,
    pages: Math.max(1, Number(response.headers.get("x-pages") ?? 1)),
  };
}

export async function syncCorporationWallet(corporationId: number): Promise<{ entries: number }> {
  const accessToken = await authorizedWalletToken(corporationId);
  try {
    const { data: balances } = await esiFetch<Array<{ division: number; balance: number }>>(
      `${ESI_BASE}/corporations/${corporationId}/wallets/?datasource=tranquility`,
      accessToken,
    );
    for (const balance of balances) {
      await db.insert(corporationWalletBalancesTable).values({
        corporationId,
        division: balance.division,
        balance: balance.balance,
        updatedAt: new Date(),
      }).onConflictDoUpdate({
        target: [
          corporationWalletBalancesTable.corporationId,
          corporationWalletBalancesTable.division,
        ],
        set: { balance: balance.balance, updatedAt: new Date() },
      });
    }

    const cutoff = monthStart(-2).getTime();
    let stored = 0;
    for (const division of balances.map((balance) => balance.division)) {
      let page = 1;
      let pages = 1;
      while (page <= pages && page <= 10) {
        const result = await esiFetch<WalletJournalEntry[]>(
          `${ESI_BASE}/corporations/${corporationId}/wallets/${division}/journal/?datasource=tranquility&page=${page}`,
          accessToken,
        );
        pages = result.pages;
        for (const entry of result.data) {
          await db.insert(corporationWalletEntriesTable).values({
            corporationId,
            division,
            refId: String(entry.id),
            refType: entry.ref_type,
            amount: Number(entry.amount),
            balance: entry.balance === undefined ? null : Number(entry.balance),
            firstPartyId: entry.first_party_id === undefined ? null : String(entry.first_party_id),
            secondPartyId: entry.second_party_id === undefined ? null : String(entry.second_party_id),
            reason: entry.reason ?? null,
            occurredAt: new Date(entry.date),
            raw: entry,
          }).onConflictDoNothing();
          stored += 1;
        }
        if (result.data.length === 0 || new Date(result.data.at(-1)!.date).getTime() < cutoff) break;
        page += 1;
      }
    }
    await db.update(corporationWalletConnectionsTable).set({
      status: "connected",
      lastError: null,
      lastSyncedAt: new Date(),
    }).where(eq(corporationWalletConnectionsTable.corporationId, corporationId));
    return { entries: stored };
  } catch (error) {
    await db.update(corporationWalletConnectionsTable).set({
      status: "error",
      lastError: error instanceof Error ? error.message.slice(0, 1_000) : "Wallet sync failed",
    }).where(eq(corporationWalletConnectionsTable.corporationId, corporationId));
    throw error;
  }
}

function entryIsExternal(corporationId: number, firstPartyId: string | null, secondPartyId: string | null): boolean {
  const id = String(corporationId);
  return !(firstPartyId === id && secondPartyId === id);
}

export async function economySummary(corporationId: number) {
  const start = monthStart(0);
  const next = monthStart(1);
  const previousStart = monthStart(-1);
  const [connection, balances, currentEntries, previousEntries, reimbursement] = await Promise.all([
    db.select({
      status: corporationWalletConnectionsTable.status,
      lastError: corporationWalletConnectionsTable.lastError,
      lastSyncedAt: corporationWalletConnectionsTable.lastSyncedAt,
    }).from(corporationWalletConnectionsTable).where(eq(corporationWalletConnectionsTable.corporationId, corporationId)).then((rows) => rows[0] ?? null),
    db.select().from(corporationWalletBalancesTable).where(eq(corporationWalletBalancesTable.corporationId, corporationId)),
    db.select().from(corporationWalletEntriesTable).where(and(
      eq(corporationWalletEntriesTable.corporationId, corporationId),
      gte(corporationWalletEntriesTable.occurredAt, start),
      lt(corporationWalletEntriesTable.occurredAt, next),
    )),
    db.select().from(corporationWalletEntriesTable).where(and(
      eq(corporationWalletEntriesTable.corporationId, corporationId),
      gte(corporationWalletEntriesTable.occurredAt, previousStart),
      lt(corporationWalletEntriesTable.occurredAt, start),
    )),
    db.select({
      total: sql<number>`COALESCE(SUM(${reimbursementClaimsTable.approvedAmount}), 0)::double precision`,
      count: sql<number>`COUNT(*)::int`,
    }).from(reimbursementClaimsTable).where(and(
      eq(reimbursementClaimsTable.corporationId, corporationId),
      eq(reimbursementClaimsTable.status, "paid"),
      gte(reimbursementClaimsTable.paidAt, start),
      lt(reimbursementClaimsTable.paidAt, next),
    )).then((rows) => rows[0]),
  ]);

  const summarize = (entries: typeof currentEntries) => {
    const external = entries.filter((entry) => entryIsExternal(corporationId, entry.firstPartyId, entry.secondPartyId));
    const income = external.filter((entry) => entry.amount > 0).reduce((sum, entry) => sum + entry.amount, 0);
    const expenses = external.filter((entry) => entry.amount < 0).reduce((sum, entry) => sum + Math.abs(entry.amount), 0);
    const group = (positive: boolean) => [...external.reduce((map, entry) => {
      if ((entry.amount > 0) !== positive || entry.amount === 0) return map;
      map.set(entry.refType, (map.get(entry.refType) ?? 0) + Math.abs(entry.amount));
      return map;
    }, new Map<string, number>()).entries()]
      .map(([source, amount]) => ({ source, amount }))
      .sort((left, right) => right.amount - left.amount)
      .slice(0, 8);
    return { income, expenses, netGrowth: income - expenses, incomeSources: group(true), expenseSources: group(false) };
  };
  const current = summarize(currentEntries);
  const previous = summarize(previousEntries);
  return {
    connection,
    periodStart: start,
    periodEnd: next,
    walletBalance: balances.reduce((sum, balance) => sum + balance.balance, 0),
    divisions: balances,
    ...current,
    previousNetGrowth: previous.netGrowth,
    reimbursementPaid: Number(reimbursement?.total ?? 0),
    reimbursementCount: Number(reimbursement?.count ?? 0),
    entryCount: currentEntries.length,
  };
}

function ruleAnalysis(summary: Awaited<ReturnType<typeof economySummary>>): EconomyAnalysis {
  const format = (value: number) => `${Math.round(value).toLocaleString("zh-CN")} ISK`;
  const actions: EconomyAction[] = [];
  const topIncome = summary.incomeSources[0];
  const topExpense = summary.expenseSources[0];
  if (summary.netGrowth < 0 && topExpense) {
    const saving = Math.round(topExpense.amount * 0.15);
    actions.push({
      title: `14天内压降 ${topExpense.source} 支出`,
      evidence: `本月净增长为 ${format(summary.netGrowth)}，${topExpense.source} 已支出 ${format(topExpense.amount)}。`,
      owner: "总监指定的财务负责人",
      steps: [
        `在48小时内导出并复核 ${topExpense.source} 的前20笔支出。`,
        "暂停非紧急、无负责人或无收益说明的同类支出7天。",
        "为恢复支出设置单笔审批线，并在第7天和第14天复盘。",
      ],
      startupCost: 0,
      timeToImpactDays: 14,
      expectedMonthlyGain: saving,
      kpi: `${topExpense.source} 月度支出至少下降15%，预计节省 ${format(saving)}。`,
      risk: "不得削减已批准的补损与关键防务支出；先由负责人逐笔分类。",
      confidence: 0.82,
    });
  }
  if (topIncome) {
    const gain = Math.round(topIncome.amount * 0.1);
    actions.push({
      title: `用7天复制 ${topIncome.source} 的高收益活动`,
      evidence: `${topIncome.source} 是本月最大收入来源，已贡献 ${format(topIncome.amount)}。`,
      owner: "对应业务负责人",
      steps: [
        "在24小时内确认该收入来源对应的负责人、活动次数与单位收益。",
        "本周追加一次同类型、同规模活动，并沿用当前收益最高的执行方式。",
        "活动结束后24小时内核对新增钱包流水，若单位收益低于历史均值80%则停止扩张。",
      ],
      startupCost: 0,
      timeToImpactDays: 7,
      expectedMonthlyGain: gain,
      kpi: `新增收入达到至少 ${format(gain)}，且单位收益不低于本月历史均值的80%。`,
      risk: "ESI流水只能证明资金结果，扩张前仍需负责人确认人力和市场容量。",
      confidence: 0.78,
    });
  }
  if (summary.income > 0 && topIncome && topIncome.amount / summary.income > 0.6 && summary.incomeSources[1]) {
    const second = summary.incomeSources[1];
    const gain = Math.round(second.amount * 0.2);
    actions.push({
      title: `30天内降低对 ${topIncome.source} 的单一依赖`,
      evidence: `${topIncome.source} 占本月收入 ${Math.round(topIncome.amount / summary.income * 100)}%，第二来源 ${second.source} 为 ${format(second.amount)}。`,
      owner: "总监与第二收入来源负责人",
      steps: [
        `本周为 ${second.source} 安排一次额外执行批次。`,
        "记录每批投入人数、启动资金、毛收入和到账时间。",
        "连续两批单位收益达到当前均值后，再增加第三批。",
      ],
      startupCost: 0,
      timeToImpactDays: 30,
      expectedMonthlyGain: gain,
      kpi: `${second.source} 月收入提高20%，预计增加 ${format(gain)}。`,
      risk: "若第二来源存在市场容量限制，应以实际成交和到账为准。",
      confidence: 0.72,
    });
  }
  return {
    source: "rules",
    model: "deterministic-economy-v1",
    generatedAt: new Date().toISOString(),
    summary: summary.entryCount === 0
      ? "尚无本月军团钱包流水，无法生成可靠的增收措施。请先连接并同步军团钱包。"
      : `本月收入 ${format(summary.income)}，支出 ${format(summary.expenses)}，净增长 ${format(summary.netGrowth)}。`,
    actions,
  };
}

function responseOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const direct = (payload as { output_text?: unknown }).output_text;
  if (typeof direct === "string") return direct;
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return null;
  for (const item of output) {
    if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) continue;
    for (const content of (item as { content: unknown[] }).content) {
      if (content && typeof content === "object" && typeof (content as { text?: unknown }).text === "string") {
        return (content as { text: string }).text;
      }
    }
  }
  return null;
}

async function openAiAnalysis(
  corporationId: number,
  summary: Awaited<ReturnType<typeof economySummary>>,
  fallback: EconomyAnalysis,
): Promise<EconomyAnalysis> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey || summary.entryCount === 0) return fallback;
  const model = process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["summary", "actions"],
    properties: {
      summary: { type: "string" },
      actions: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "evidence", "owner", "steps", "startupCost", "timeToImpactDays", "expectedMonthlyGain", "kpi", "risk", "confidence"],
          properties: {
            title: { type: "string" }, evidence: { type: "string" }, owner: { type: "string" },
            steps: { type: "array", minItems: 3, maxItems: 6, items: { type: "string" } },
            startupCost: { type: "number", minimum: 0 },
            timeToImpactDays: { type: "integer", minimum: 1, maximum: 30 },
            expectedMonthlyGain: { type: "number", minimum: 0 },
            kpi: { type: "string" }, risk: { type: "string" }, confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };
  try {
    const response = await fetch(OPENAI_RESPONSES_URL, {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        store: false,
        safety_identifier: `eve-economy-corporation-${corporationId}`,
        reasoning: { effort: "medium" },
        text: { verbosity: "low", format: { type: "json_schema", name: "eve_corporation_economy", strict: true, schema } },
        instructions: "你是EVE军团财务顾问。只能根据提供的本月和上月钱包汇总提出简体中文建议。建议必须具体、可在30天内执行、见效尽量快，包含负责人、至少3个步骤、启动成本、见效天数、保守的月度增收或节支金额、KPI、风险和可信度。不得虚构钱包之外的人数、市场价格、产量或活动信息；证据不足时明确要求负责人核实。预计收益不得超过作为依据的对应收入或支出的20%。",
        input: JSON.stringify(summary),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const text = responseOutputText(await response.json());
    if (!text) return fallback;
    const parsed = JSON.parse(text) as { summary: string; actions: EconomyAction[] };
    return { source: "openai", model, generatedAt: new Date().toISOString(), summary: parsed.summary, actions: parsed.actions };
  } catch {
    return fallback;
  } finally {
    clearTimeout(timeout);
  }
}

export async function analyzeEconomy(corporationId: number, userId: number): Promise<EconomyAnalysis> {
  const summary = await economySummary(corporationId);
  const fallback = ruleAnalysis(summary);
  const analysis = await openAiAnalysis(corporationId, summary, fallback);
  await db.insert(economyAnalysesTable).values({
    corporationId,
    periodStart: summary.periodStart,
    periodEnd: summary.periodEnd,
    source: analysis.source,
    model: analysis.model,
    analysis,
    createdBy: userId,
  });
  return analysis;
}

export async function latestEconomyAnalysis(corporationId: number): Promise<EconomyAnalysis | null> {
  const [row] = await db.select({ analysis: economyAnalysesTable.analysis }).from(economyAnalysesTable).where(
    eq(economyAnalysesTable.corporationId, corporationId),
  ).orderBy(desc(economyAnalysesTable.createdAt)).limit(1);
  return (row?.analysis as EconomyAnalysis | undefined) ?? null;
}
