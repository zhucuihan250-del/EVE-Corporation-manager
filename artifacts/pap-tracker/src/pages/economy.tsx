import { useQueryClient } from "@tanstack/react-query";
import { useAnalyzeCorporationEconomy, useGetEconomySummary, useSyncCorporationWallet } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { apiUrl } from "@/lib/api";
import { BrainCircuit, Landmark, RefreshCw, Sparkles, TrendingDown, TrendingUp, WalletCards } from "lucide-react";

const formatIsk = (value: number) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value)} ISK`;

export function Economy() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const summary = useGetEconomySummary();
  const sync = useSyncCorporationWallet();
  const analyze = useAnalyzeCorporationEconomy();
  const data = summary.data;
  const categoryLabels: Record<string, string> = {
    cost_control: tr("成本控制", "Cost control"),
    existing_revenue: tr("复制已到账收入", "Scale verified revenue"),
    diversification: tr("非税多元化", "Non-tax diversification"),
    operations: tr("运营项目", "Operations"),
    data_quality: tr("收入归因", "Revenue attribution"),
  };
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["/api/economy"] });
  const run = (kind: "sync" | "analyze") => {
    const mutation = kind === "sync" ? sync : analyze;
    mutation.mutate(undefined, {
      onSuccess: async () => { await refresh(); toast({ title: kind === "sync" ? tr("军团钱包已同步", "Corporation wallet synchronized") : tr("经济建议已更新", "Economy advice updated") }); },
      onError: (error) => toast({ title: tr("操作失败", "Operation failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  if (summary.isLoading) return <div className="p-6 text-muted-foreground">{tr("正在读取军团经济…", "Loading corporation economy…")}</div>;
  if (summary.isError) return <div className="p-6 text-destructive">{getErrorMessage(summary.error)}</div>;

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div className="flex flex-wrap justify-between gap-4"><div><h1 className="text-2xl font-bold font-mono tracking-wider">{tr("军团经济", "CORPORATION ECONOMY")}</h1><p className="text-sm text-muted-foreground mt-1">{tr("仅总监权限可见；数据与分析严格限定在当前军团。", "Director-only data and analysis, strictly scoped to this corporation.")}</p></div><div className="flex flex-wrap gap-2">{!data?.connection && <Button asChild variant="outline"><a href={apiUrl("/api/economy/connect")}><WalletCards className="h-4 w-4 mr-2" />{tr("授权军团钱包", "Authorize wallet")}</a></Button>}<Button variant="outline" onClick={() => run("sync")} disabled={sync.isPending || !data?.connection}><RefreshCw className={`h-4 w-4 mr-2 ${sync.isPending ? "animate-spin" : ""}`} />{tr("同步数据", "Sync data")}</Button><Button onClick={() => run("analyze")} disabled={analyze.isPending || !data?.connection}><Sparkles className="h-4 w-4 mr-2" />{tr("生成快速收入建议", "Generate rapid-growth advice")}</Button></div></div>

      {!data?.connection && <Card className="border-amber-500/40"><CardHeader><CardTitle className="flex items-center gap-2"><Landmark className="h-5 w-5 text-amber-400" />{tr("尚未授权军团钱包", "Wallet authorization required")}</CardTitle><CardDescription>{tr("请由拥有军团钱包权限的总监通过 EVE SSO 授权。未获得真实数据前，系统不会编造收入或建议。", "A director with wallet access must authorize through EVE SSO. The system will not invent figures or advice before real data is available.")}</CardDescription></CardHeader></Card>}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric title={tr("当前余额", "Wallet balance")} value={formatIsk(data?.walletBalance ?? 0)} icon={<WalletCards className="h-5 w-5" />} />
        <Metric title={tr("本月收入", "Monthly income")} value={formatIsk(data?.income ?? 0)} icon={<TrendingUp className="h-5 w-5 text-emerald-400" />} />
        <Metric title={tr("本月支出", "Monthly expenses")} value={formatIsk(data?.expenses ?? 0)} icon={<TrendingDown className="h-5 w-5 text-rose-400" />} />
        <Metric title={tr("本月净增长", "Monthly net growth")} value={formatIsk(data?.netGrowth ?? 0)} icon={(data?.netGrowth ?? 0) >= 0 ? <TrendingUp className="h-5 w-5 text-emerald-400" /> : <TrendingDown className="h-5 w-5 text-rose-400" />} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SourceCard title={tr("主要收入来源", "Primary income sources")} empty={tr("本月暂无收入记录", "No income recorded this month")} sources={data?.incomeSources ?? []} />
        <SourceCard title={tr("主要支出去向", "Primary expense sources")} empty={tr("本月暂无支出记录", "No expenses recorded this month")} sources={data?.expenseSources ?? []} />
      </div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><BrainCircuit className="h-5 w-5 text-primary" />{tr("AI 快速增收行动方案", "AI rapid-income action plan")}</CardTitle><CardDescription>{data?.analysis ? `${data.analysis.summary} · ${tr("生成于", "Generated")} ${new Date(data.analysis.generatedAt).toLocaleString()}` : tr("同步钱包后生成具体、可执行、见效快的建议。系统不会把提高税率或扩大征税作为方案。", "Sync the wallet, then generate specific, feasible actions with a short time to impact. Raising or expanding taxes is not treated as an action plan.")}</CardDescription></CardHeader>
        <CardContent className="space-y-4">{!data?.analysis ? <p className="text-sm text-muted-foreground">{tr("暂无分析。", "No analysis yet.")}</p> : data.analysis.actions.map((action, index) => <div key={`${action.title}-${index}`} className="rounded-md border border-border/50 p-4 space-y-3"><div className="flex flex-wrap justify-between gap-2"><div><div className="font-semibold">{index + 1}. {action.title}</div><div className="mt-1 flex flex-wrap gap-2">{action.category && <Badge variant="secondary">{categoryLabels[action.category] ?? action.category}</Badge>}{action.taxIndependent && <Badge variant="outline" className="border-emerald-500/40 text-emerald-300">{tr("非税收方案", "Tax-independent")}</Badge>}</div></div><div className="flex flex-wrap gap-2"><Badge variant="outline">{tr(`${action.timeToImpactDays} 天见效`, `${action.timeToImpactDays} days to impact`)}</Badge><Badge>{action.expectedMonthlyGain > 0 ? tr(`月增收/节支上限 ${formatIsk(action.expectedMonthlyGain)}`, `Monthly gain/saving cap ${formatIsk(action.expectedMonthlyGain)}`) : tr("收益待实际到账验证", "Gain pending verified cash flow")}</Badge></div></div><p className="text-sm text-muted-foreground">{action.evidence}</p><ol className="list-decimal pl-5 text-sm space-y-1">{action.steps.map((step) => <li key={step}>{step}</li>)}</ol><div className="grid gap-2 text-xs md:grid-cols-2"><div><span className="text-muted-foreground">{tr("责任人：", "Owner: ")}</span>{action.owner}</div><div><span className="text-muted-foreground">{tr("启动费用：", "Startup cost: ")}</span>{formatIsk(action.startupCost)}</div><div><span className="text-muted-foreground">KPI：</span>{action.kpi}</div><div><span className="text-muted-foreground">{tr("风险：", "Risk: ")}</span>{action.risk}</div></div><div className="space-y-1"><div className="flex justify-between text-xs text-muted-foreground"><span>{tr("置信度", "Confidence")}</span><span>{Math.round(action.confidence * 100)}%</span></div><Progress value={action.confidence * 100} /></div></div>)}</CardContent>
      </Card>
    </div>
  );
}

function Metric({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return <Card><CardHeader className="pb-2"><CardDescription className="flex items-center justify-between">{title}{icon}</CardDescription></CardHeader><CardContent><div className="text-xl font-bold font-mono break-all">{value}</div></CardContent></Card>;
}

function SourceCard({ title, empty, sources }: { title: string; empty: string; sources: { source: string; amount: number }[] }) {
  return <Card><CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader><CardContent className="space-y-3">{sources.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : sources.map((source) => <div key={source.source} className="flex justify-between gap-3 text-sm"><span className="text-muted-foreground">{source.source}</span><span className="font-mono font-medium">{formatIsk(source.amount)}</span></div>)}</CardContent></Card>;
}
