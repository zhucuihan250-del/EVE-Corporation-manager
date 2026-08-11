import {
  corporationWalletBalancesTable,
  corporationWalletConnectionsTable,
  corporationWalletEntriesTable,
  corporationsTable,
  courierOrdersTable,
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
  category: "cost_control" | "existing_revenue" | "diversification" | "operations" | "data_quality";
  taxIndependent: boolean;
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
  const [connection, balances, currentEntries, previousEntries, reimbursement, corporation, courierMetrics] = await Promise.all([
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
    db.select({ courierEnabled: corporationsTable.courierEnabled }).from(corporationsTable).where(
      eq(corporationsTable.id, corporationId),
    ).then((rows) => rows[0] ?? { courierEnabled: false }),
    db.select({
      completedFees: sql<number>`COALESCE(SUM(CASE WHEN ${courierOrdersTable.status} = 'completed' AND ${courierOrdersTable.completedAt} >= ${start} AND ${courierOrdersTable.completedAt} < ${next} THEN ${courierOrdersTable.calculatedFee} ELSE 0 END), 0)::double precision`,
      completedOrders: sql<number>`COUNT(*) FILTER (WHERE ${courierOrdersTable.status} = 'completed' AND ${courierOrdersTable.completedAt} >= ${start} AND ${courierOrdersTable.completedAt} < ${next})::int`,
      openOrders: sql<number>`COUNT(*) FILTER (WHERE ${courierOrdersTable.status} IN ('submitted', 'accepted', 'in_transit'))::int`,
    }).from(courierOrdersTable).where(
      eq(courierOrdersTable.corporationId, corporationId),
    ).then((rows) => rows[0]),
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
    operationalPrograms: {
      courier: {
        enabled: corporation.courierEnabled,
        completedOrders: Number(courierMetrics?.completedOrders ?? 0),
        completedFees: Number(courierMetrics?.completedFees ?? 0),
        openOrders: Number(courierMetrics?.openOrders ?? 0),
      },
    },
  };
}

const TAX_SOURCE_PATTERN = /(tax|bounty_prizes|corporation_tax|交易税|赏金税|军团税)/i;
const TAX_INCREASE_PATTERN = /(提高|上调|增加|扩大|强化|调整|设定).{0,8}(税率|征税|税收)|(税率|征税).{0,8}(提高|上调|增加|调整至|设为)|刷怪增收|赏金活动|raise.{0,12}tax|increase.{0,12}tax|set.{0,12}tax|higher tax rate|ratting income/i;

function isTaxSource(source: string): boolean {
  return TAX_SOURCE_PATTERN.test(source);
}

function isTaxIncreaseAction(action: EconomyAction): boolean {
  const text = [action.title, action.evidence, action.kpi, action.risk, ...action.steps].filter(Boolean).join(" ");
  return TAX_INCREASE_PATTERN.test(text) || (action.category === "existing_revenue" && TAX_SOURCE_PATTERN.test(text));
}

function ruleAnalysis(summary: Awaited<ReturnType<typeof economySummary>>): EconomyAnalysis {
  const format = (value: number) => `${Math.round(value).toLocaleString("zh-CN")} ISK`;
  if (summary.entryCount === 0) {
    return {
      source: "rules",
      model: "deterministic-economy-v2-non-tax",
      generatedAt: new Date().toISOString(),
      summary: "尚无本月军团钱包流水，无法生成可靠的增收措施。请先连接并同步军团钱包。",
      actions: [],
    };
  }
  const actions: EconomyAction[] = [];
  const nonTaxIncome = summary.incomeSources.filter((source) => !isTaxSource(source.source));
  const taxIncome = summary.incomeSources.filter((source) => isTaxSource(source.source)).reduce((sum, source) => sum + source.amount, 0);
  const topIncome = nonTaxIncome[0];
  const topExpense = summary.expenseSources[0];
  if (topExpense) {
    const saving = Math.round(topExpense.amount * (summary.netGrowth < 0 ? 0.15 : 0.08));
    actions.push({
      category: "cost_control", taxIndependent: true,
      title: `${summary.netGrowth < 0 ? "14" : "21"}天内压降 ${topExpense.source} 的无效支出`,
      evidence: `本月净增长为 ${format(summary.netGrowth)}，${topExpense.source} 已支出 ${format(topExpense.amount)}，是当前最大支出来源。`,
      owner: "总监指定的财务负责人",
      steps: [
        `在48小时内导出并复核 ${topExpense.source} 的前20笔支出。`,
        "把每笔标记为补损、防务、运营投入或可暂停支出；补损与关键防务不得自动削减。",
        "暂停无负责人、无用途说明且可延后的同类支出7天，为恢复支付设置单笔审批线。",
        `在第7天和第${summary.netGrowth < 0 ? "14" : "21"}天核对钱包流水，只有已到账节支才计入结果。`,
      ],
      startupCost: 0,
      timeToImpactDays: summary.netGrowth < 0 ? 14 : 21,
      expectedMonthlyGain: saving,
      kpi: `${topExpense.source} 可暂停部分的月度支出目标下降 ${summary.netGrowth < 0 ? "15" : "8"}%，上限按 ${format(saving)} 验证。`,
      risk: "不得削减已批准的补损与关键防务支出；先由负责人逐笔分类。",
      confidence: 0.82,
    });
  }
  if (topIncome) {
    const gain = Math.round(topIncome.amount * 0.1);
    actions.push({
      category: "existing_revenue", taxIndependent: true,
      title: `用7天复制 ${topIncome.source} 的高收益活动`,
      evidence: `${topIncome.source} 是本月最大的非税收入来源，已贡献 ${format(topIncome.amount)}。`,
      owner: "对应业务负责人",
      steps: [
        "在24小时内确认该收入来源对应的负责人、活动次数与单位收益。",
        "本周追加一次同类型、同规模活动，并沿用当前收益最高的执行方式。",
        "活动结束后24小时内核对新增钱包流水，若单位收益低于历史均值80%则停止扩张。",
      ],
      startupCost: 0, timeToImpactDays: 7, expectedMonthlyGain: gain,
      kpi: `新增收入达到至少 ${format(gain)}，且单位收益不低于本月历史均值的80%。`,
      risk: "ESI流水只能证明资金结果，扩张前仍需负责人确认人力和市场容量。", confidence: 0.78,
    });
  }
  if (summary.operationalPrograms.courier.enabled) {
    const courier = summary.operationalPrograms.courier;
    actions.push({
      category: "operations", taxIndependent: true,
      title: "7天验证快递服务能否形成军团非税收入",
      evidence: `网站快递模块已启用；本月完成 ${courier.completedOrders} 单，已计算快递费 ${format(courier.completedFees)}，当前另有 ${courier.openOrders} 单处理中。快递费是否实际进入军团钱包仍需核对。`,
      owner: "快递管理员与财务负责人",
      steps: [
        "在24小时内逐单核对本月已完成订单的快递费收款方、到账时间和对应钱包流水。",
        "仅将确实进入军团钱包的服务费纳入军团收入；个人快递员收入单独列示，不得混算。",
        "选择订单量最高的一条现有路线做7天试点，保持既有价格并记录询价数、下单数、完成时长和到账额。",
        "第7天只在到账额为正且准时完成率达到90%时扩大该路线，否则调整价格或暂停。",
      ],
      startupCost: 0, timeToImpactDays: 7, expectedMonthlyGain: 0,
      kpi: "完成订单与钱包流水逐单匹配率100%；试点路线准时完成率至少90%，军团实际到账额单独统计。",
      risk: "快递费可能属于个人收入；在钱包流水确认前不得把计算金额当作军团收益。",
      confidence: courier.completedOrders > 0 ? 0.8 : 0.62,
    });
  }
  if (summary.income > 0 && topIncome && topIncome.amount / Math.max(1, summary.income - taxIncome) > 0.6 && nonTaxIncome[1]) {
    const second = nonTaxIncome[1];
    const gain = Math.round(second.amount * 0.2);
    actions.push({
      category: "diversification", taxIndependent: true,
      title: `30天内降低对 ${topIncome.source} 的单一依赖`,
      evidence: `${topIncome.source} 占非税收入 ${Math.round(topIncome.amount / Math.max(1, summary.income - taxIncome) * 100)}%，第二个非税来源 ${second.source} 为 ${format(second.amount)}。`,
      owner: "总监与第二收入来源负责人",
      steps: [`本周为 ${second.source} 安排一次额外执行批次。`, "记录每批投入人数、启动资金、毛收入和到账时间。", "连续两批单位收益达到当前均值后，再增加第三批。"],
      startupCost: 0, timeToImpactDays: 30, expectedMonthlyGain: gain,
      kpi: `${second.source} 月收入提高20%，预计增加 ${format(gain)}。`,
      risk: "若第二来源存在市场容量限制，应以实际成交和到账为准。", confidence: 0.72,
    });
  }
  if (!topIncome || (summary.income > 0 && taxIncome / summary.income >= 0.5)) {
    actions.push({
      category: "diversification", taxIndependent: true,
      title: "14天建立第一条可验证的非税收入流水",
      evidence: topIncome ? `税收类流水约占本月收入 ${Math.round(taxIncome / Math.max(1, summary.income) * 100)}%，非税来源过度集中。` : `当前收入来源中未识别到稳定的非税流水；税收类流水为 ${format(taxIncome)}。`,
      owner: "总监指定的非税收入项目负责人",
      steps: [
        "48小时内从合同服务、制造代工、物资回购转售和物流服务中只选一个试点，并指定唯一负责人。",
        "试点开始前记录启动资金上限、收款钱包分部、每笔成本和停止条件；未经批准不动用军团资金。",
        "连续7天把每笔合同、采购、销售或服务收入与钱包 ref_type 和 reason 对齐，个人收入不得计入。",
        "第14天只保留已产生正向净到账且可重复的渠道；没有到账则结束试点并更换渠道。",
      ],
      startupCost: 0, timeToImpactDays: 14, expectedMonthlyGain: 0,
      kpi: "14天内至少形成1笔可与钱包流水一一对应的非税净收入；未到账时收益按0计算。",
      risk: "钱包数据无法证明军团具备制造、市场或物流产能，必须先小规模验证，禁止预填预期利润。", confidence: 0.68,
    });
  }
  if (actions.length < 2) {
    actions.push({
      category: "operations", taxIndependent: true,
      title: "7天完成闲置余额与固定付款复核",
      evidence: `当前钱包余额为 ${format(summary.walletBalance)}，本月净增长 ${format(summary.netGrowth)}；现有流水不足以证明哪些余额已被项目占用。`,
      owner: "财务负责人",
      steps: ["在48小时内按钱包分部列出可用余额、已承诺付款和最低安全储备，三者不得混算。", "为未来7天所有计划付款补充负责人、用途、截止日期和对应收入来源。", "第7天取消无负责人且无截止日期的资金预留，把释放金额记录为可用余额而不是收入。"],
      startupCost: 0, timeToImpactDays: 7, expectedMonthlyGain: 0,
      kpi: "所有钱包分部均有可用余额、承诺付款和安全储备三项对账，未确认预留金额降为0。",
      risk: "释放预留不等于新增收入；不得挪用补损、主权或防务专用资金。", confidence: 0.78,
    });
  }
  actions.push({
    category: "data_quality", taxIndependent: true,
    title: "3天内建立收入归因表，停止把税收与经营收入混算",
    evidence: `本月有 ${summary.entryCount} 条钱包流水、${summary.incomeSources.length} 类收入来源；当前分析只能看到 ESI ref_type，无法自动证明每笔收入对应的业务活动。`,
    owner: "军团财务负责人",
    steps: ["为本月前20笔收入补充业务负责人、活动名称、是否税收、直接成本和到账钱包分部。", "把税收类、成员捐赠、合同/服务、市场交易和其他收入分开汇总；无法确认的条目进入待核对，不分配收益目标。", "从下周开始要求经营类收款使用统一 reason 前缀，并每周核对一次钱包流水。"],
    startupCost: 0, timeToImpactDays: 3, expectedMonthlyGain: 0,
    kpi: "前20笔收入归因完成率100%，非税经营收入可以按负责人和项目独立汇总。",
    risk: "这是数据治理动作，不直接承诺增收；作用是阻止 AI 用税收流水替代经营分析。", confidence: 0.94,
  });
  return {
    source: "rules", model: "deterministic-economy-v2-non-tax", generatedAt: new Date().toISOString(),
    summary: summary.entryCount === 0 ? "尚无本月军团钱包流水，无法生成可靠的增收措施。请先连接并同步军团钱包。" : `本月收入 ${format(summary.income)}，支出 ${format(summary.expenses)}，净增长 ${format(summary.netGrowth)}。本轮方案已排除提高税率或扩大征税，优先使用非税经营、实际到账和成本控制证据。`,
    actions: actions.slice(0, 5),
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
        minItems: 3,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["category", "taxIndependent", "title", "evidence", "owner", "steps", "startupCost", "timeToImpactDays", "expectedMonthlyGain", "kpi", "risk", "confidence"],
          properties: {
            category: { type: "string", enum: ["cost_control", "existing_revenue", "diversification", "operations", "data_quality"] },
            taxIndependent: { type: "boolean", enum: [true] },
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
        text: { verbosity: "medium", format: { type: "json_schema", name: "eve_corporation_economy", strict: true, schema } },
        instructions: "你是 EVE 军团经营分析员。只能根据提供的本月、上月钱包汇总和已启用的运营模块提出简体中文建议。禁止建议提高税率、扩大征税、用更多刷怪税收替代经营收入，所有 action 的 taxIndependent 必须为 true；允许在 evidence 中指出税收集中风险，但措施必须转向非税经营或成本控制。至少给出3条、最多5条建议，并优先顺序为：压降可验证的无效成本、复制已经到账的非税收入、验证合同/制造/物流/市场等非税渠道、改善收入归因。每条建议必须引用具体 ref_type、金额、订单数或当前净增长，写明负责人、3至6个有完成时限的步骤、启动成本、1至30天见效时间、保守的月度增收或节支、可量化 KPI、风险和可信度。不得虚构人数、市场价格、利润率、产量、订单需求或活动能力；钱包无法证明时 expectedMonthlyGain 必须为0，并把核实动作写入步骤。预计收益不得超过作为依据的单一收入或支出的20%，成员个人收入不得当作军团收入。",
        input: JSON.stringify({
          ...summary,
          taxContext: {
            taxLikeSources: summary.incomeSources.filter((source) => isTaxSource(source.source)),
            rule: "Tax-like sources may be cited as concentration risk but may not be expanded as an action.",
          },
        }),
      }),
    });
    if (!response.ok) throw new Error(`OpenAI ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const text = responseOutputText(await response.json());
    if (!text) return fallback;
    const parsed = JSON.parse(text) as { summary: string; actions: EconomyAction[] };
    const evidenceCap = Math.max(
      0,
      ...summary.incomeSources.map((source) => source.amount * 0.2),
      ...summary.expenseSources.map((source) => source.amount * 0.2),
    );
    const accepted = Array.isArray(parsed.actions)
      ? parsed.actions
          .filter((action) => action.taxIndependent === true && Array.isArray(action.steps) && action.steps.length >= 3 && !isTaxIncreaseAction(action))
          .map((action) => ({
            ...action,
            startupCost: Math.max(0, Number(action.startupCost) || 0),
            timeToImpactDays: Math.max(1, Math.min(30, Math.round(Number(action.timeToImpactDays) || 30))),
            expectedMonthlyGain: Math.max(0, Math.min(evidenceCap, Number(action.expectedMonthlyGain) || 0)),
            confidence: Math.max(0, Math.min(1, Number(action.confidence) || 0)),
          }))
      : [];
    const seen = new Set<string>();
    const actions = [...accepted, ...fallback.actions]
      .filter((action) => {
        const key = action.title.trim().toLocaleLowerCase();
        if (!key || seen.has(key) || isTaxIncreaseAction(action)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, 5);
    return {
      source: accepted.length > 0 ? "openai" : "rules",
      model: accepted.length > 0 ? model : fallback.model,
      generatedAt: new Date().toISOString(),
      summary: accepted.length > 0 && typeof parsed.summary === "string" ? parsed.summary.slice(0, 3_000) : fallback.summary,
      actions,
    };
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
