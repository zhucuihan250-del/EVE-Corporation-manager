import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Calculator,
  Copy,
  History,
  Loader2,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import {
  buybackApi,
  buybackKeys,
  buybackBasisLabel,
  formatBuybackIsk,
  type BuybackQuote,
} from "@/lib/buyback-api";
import { canCopyBuybackQuote } from "@/lib/buyback-presentation";

export function BuybackQuoteDetails({
  quote,
  now,
  allowCopy = true,
}: {
  quote: BuybackQuote;
  now: number;
  allowCopy?: boolean;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const { toast } = useToast();
  const [copying, setCopying] = useState(false);
  const [manualCopy, setManualCopy] = useState(false);
  const expired = new Date(quote.expiresAt).getTime() <= now;
  const canCopy = canCopyBuybackQuote(quote, now) && allowCopy;
  const statuses = {
    accepted: tr("可回收", "Accepted"),
    excluded: tr("不回收", "Excluded"),
    unrecognized: tr("无法识别", "Unrecognized"),
    unpriced: tr("待定价", "Unpriced"),
    invalid: tr("格式有误", "Invalid input"),
  };
  const copy = async () => {
    // Recheck the deadline at click time, not just the periodic display tick.
    if (!allowCopy || !canCopyBuybackQuote(quote, Date.now())) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(quote.totalIsk);
      toast({
        title: tr("合同金额已复制", "Contract amount copied"),
        description: tr(
          "请在游戏中创建物品交换合同并核对接收方和物品。",
          "Create an item exchange contract in game and verify the recipient and items.",
        ),
      });
    } catch {
      setManualCopy(true);
      toast({
        title: tr("剪切板不可用", "Clipboard unavailable"),
        description: tr(
          "请手动复制下方金额。",
          "Please copy the amount manually.",
        ),
        variant: "destructive",
      });
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-primary/25 bg-primary/5 p-4">
        <div className="min-w-0">
          <div className="text-sm text-muted-foreground">
            {quote.complete
              ? tr("合同金额", "Contract amount")
              : tr(
                  "可回收小计 · 非完整合同金额",
                  "Accepted subtotal · not a complete contract quote",
                )}
          </div>
          <div className="mt-1 break-all text-2xl font-bold tabular-nums text-primary">
            {formatBuybackIsk(quote.totalIsk)}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Badge
              variant={expired || !quote.complete ? "secondary" : "default"}
            >
              {expired
                ? tr("已过期", "Expired")
                : quote.complete
                  ? tr("有效报价", "Valid quote")
                  : tr("需要处理问题项", "Needs attention")}
            </Badge>
            <span>
              {tr("报价", "Quote")} #{quote.id} · {tr("规则版本", "Rules v")}
              {quote.settingsVersion}
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            {tr("生成于", "Created")}{" "}
            {new Date(quote.createdAt).toLocaleString()} ·{" "}
            {tr("有效至", "Expires")}{" "}
            {new Date(quote.expiresAt).toLocaleString()}
          </p>
        </div>
        {allowCopy && (
          <Button onClick={copy} disabled={!canCopy || copying}>
            <Copy className="mr-2 h-4 w-4" />
            {tr("复制合同金额", "Copy contract amount")}
          </Button>
        )}
      </div>
    {manualCopy && canCopy && (
      <div className="space-y-2">
        <Label htmlFor={`buyback-copy-${quote.id}`}>{tr("手动复制合同金额（不含分隔符）", "Copy manually (no separators)")}</Label>
        <Input id={`buyback-copy-${quote.id}`} className="font-mono" readOnly value={quote.totalIsk} onFocus={(event) => event.currentTarget.select()} />
      </div>
    )}
    {!quote.complete && (
        <div
          role="alert"
          className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
        >
          {tr(
            "下方存在不回收、无法识别、待定价或格式有误的物品。请从游戏合同和输入清单中移除这些物品，或让管理员补充规则，再重新计算；当前小计不能直接作为整份清单的合同金额。",
            "Some items are excluded, unrecognized, unpriced, or invalid. Remove them from both the in-game contract and input, or ask an administrator to update the rules, then recalculate. This subtotal is not a quote for the full list.",
          )}
        </div>
      )}
      {expired && (
        <p className="text-sm text-amber-300">
          {tr(
            "此报价已过期，请重新粘贴清单生成新报价。历史价格保留用于核对，不会随新规则改变。",
            "This quote has expired. Paste the item list again for a new quote. Historical prices remain unchanged for reference.",
          )}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border border-border/60">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border/60 bg-muted/20 text-xs text-muted-foreground">
            <tr>
              {[
                tr("物品／状态", "Item / status"),
                tr("数量", "Quantity"),
                tr("参考单价", "Reference unit price"),
                tr("回收比例", "Rate"),
                tr("回收单价", "Buyback unit price"),
                tr("小计", "Subtotal"),
              ].map((label) => (
                <th key={label} className="px-3 py-3 font-medium">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {quote.lines.map((line, index) => (
              <tr
                key={`${line.typeId}-${index}`}
                className={`border-b border-border/40 last:border-b-0 ${line.status === "accepted" ? "" : "bg-amber-500/5"}`}
              >
                <td className="max-w-[300px] px-3 py-3">
                  <div className="font-medium break-words">
                    {line.name || line.inputName}
                  </div>
                  <div
                    className={`mt-1 text-xs ${line.status === "accepted" ? "text-emerald-400" : "text-amber-300"}`}
                  >
                    {statuses[line.status]}
                  </div>
                  {line.reason && (
                    <p className="mt-1 text-xs text-muted-foreground whitespace-pre-wrap">
                      {line.reason}
                    </p>
                  )}
                </td>
                <td className="px-3 py-3 tabular-nums">{line.quantity}</td>
                <td className="px-3 py-3 tabular-nums">
                  <div className="whitespace-nowrap">
                    {formatBuybackIsk(line.referencePrice)}
                  </div>
                  {line.priceBasis && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {buybackBasisLabel(line.priceBasis, zh)}
                    </div>
                  )}
                  {line.priceBasis !== "fixed" && line.marketUpdatedAt && (
                    <div className="mt-1 text-xs text-muted-foreground">
                      {tr("行情更新", "Price updated")}:{" "}
                      {new Date(line.marketUpdatedAt).toLocaleString()}
                    </div>
                  )}
                </td>
                <td className="px-3 py-3 tabular-nums">
                  {line.ratePercent == null ? "—" : `${line.ratePercent}%`}
                </td>
                <td className="whitespace-nowrap px-3 py-3 tabular-nums">
                  {formatBuybackIsk(line.unitPrice)}
                </td>
                <td className="whitespace-nowrap px-3 py-3 font-medium tabular-nums">
                  {formatBuybackIsk(line.totalIsk)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BuybackQuoteHistory({
  quotes,
  now,
  admin = false,
}: {
  quotes: BuybackQuote[];
  now: number;
  admin?: boolean;
}) {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  if (!quotes.length)
    return (
      <p className="py-4 text-sm text-muted-foreground">
        {tr("暂无报价记录。", "No quotes yet.")}
      </p>
    );
  return (
    <div className="space-y-3">
      {quotes.map((quote) => (
        <details
          key={quote.id}
          className="group rounded-lg border border-border/60"
          open={expanded.has(quote.id)}
          onToggle={(event) => {
            const open = event.currentTarget.open;
            setExpanded((current) => {
              if (current.has(quote.id) === open) return current;
              const next = new Set(current);
              if (open) next.add(quote.id);
              else next.delete(quote.id);
              return next;
            });
          }}
        >
          <summary className="cursor-pointer p-4 text-sm marker:text-primary">
            <span className="inline-flex max-w-full flex-wrap items-center gap-x-4 gap-y-2 align-middle">
              <strong>#{quote.id}</strong>
              {admin && quote.submitterName && (
                <span>{quote.submitterName}</span>
              )}
              <span className="text-muted-foreground">
                {new Date(quote.createdAt).toLocaleString()}
              </span>
              <span className="font-mono">
                {formatBuybackIsk(quote.totalIsk)}
              </span>
              <Badge variant="secondary">
                {new Date(quote.expiresAt).getTime() <= now
                  ? tr("已过期", "Expired")
                  : quote.complete
                    ? tr("有效", "Valid")
                    : tr("待处理", "Needs attention")}
              </Badge>
            </span>
          </summary>
          {expanded.has(quote.id) && (
            <div className="border-t border-border/60 p-4">
              <BuybackQuoteDetails quote={quote} now={now} allowCopy={!admin} />
            </div>
          )}
        </details>
      ))}
    </div>
  );
}

export function Buyback() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [result, setResult] = useState<BuybackQuote | null>(null);
  const [quotedText, setQuotedText] = useState("");
  const pendingRequest = useRef<{
    text: string;
    version: number;
    requestId: string;
  } | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const configuration = useQuery({
    queryKey: buybackKeys.settings,
    queryFn: ({ signal }) => buybackApi.settings(signal),
  });
  const history = useQuery({
    queryKey: buybackKeys.quotes,
    queryFn: ({ signal }) => buybackApi.quotes(signal),
  });
  const calculate = useMutation({
    mutationFn: buybackApi.quote,
    onSuccess: (quote, input) => {
      setResult(quote);
      setQuotedText(input.text);
      pendingRequest.current = null;
      void queryClient.invalidateQueries({ queryKey: buybackKeys.quotes });
      if (Date.parse(quote.expiresAt) <= Date.now())
        toast({
          title: tr(
            "已恢复上一次报价，但已过期",
            "Previous quote recovered, but expired",
          ),
          description: tr(
            "请再次点击“计算合同金额”获取新的报价。",
            "Click Calculate contract amount again to get a new quote.",
          ),
        });
    },
    onError: (error) => {
      toast({
        title: tr("计算失败", "Quote failed"),
        description: getErrorMessage(error),
        variant: "destructive",
      });
      void queryClient.invalidateQueries({ queryKey: buybackKeys.settings });
    },
  });
  const settings = configuration.data?.settings;
  const submitQuote = () => {
    if (!settings?.enabled || calculate.isPending || !text.trim()) return;
    // A lost response must be retried with the same key, not create a second quote.
    if (
      !pendingRequest.current ||
      pendingRequest.current.text !== text ||
      pendingRequest.current.version !== settings.version
    ) {
      pendingRequest.current = {
        text,
        version: settings.version,
        requestId: crypto.randomUUID(),
      };
    }
    calculate.mutate({ text, requestId: pendingRequest.current.requestId });
  };
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: buybackKeys.all });
  const inputChanged = result !== null && text !== quotedText;
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Calculator className="h-6 w-6 text-primary" />
            {tr("回收计算器", "Buyback calculator")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              "粘贴物品清单，计算挂给军团的物品交换合同金额。",
              "Paste an item list to calculate the amount for your corporation item exchange contract.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={configuration.isFetching || history.isFetching}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {tr("刷新", "Refresh")}
        </Button>
      </div>
      {configuration.isLoading && (
        <p
          role="status"
          className="flex items-center gap-2 text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {tr("正在加载回收规则…", "Loading buyback rules…")}
        </p>
      )}
      {configuration.isError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-4 text-sm text-destructive"
        >
          {getErrorMessage(configuration.error)}
        </p>
      )}
      {settings && !settings.enabled && (
        <div
          role="status"
          className="flex gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm"
        >
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <div>
            <strong>
              {tr("回收报价暂未开放", "Buyback quoting is paused")}
            </strong>
            <p className="mt-1 text-muted-foreground">
              {tr(
                "请等待管理员设置价格并开启功能。历史报价仍可查看。",
                "An administrator must configure pricing and enable quoting. Previous quotes remain available.",
              )}
            </p>
          </div>
        </div>
      )}
      <Card>
        <CardHeader>
          <CardTitle>{tr("物品清单", "Item list")}</CardTitle>
          <CardDescription>
            {tr(
              "在游戏物品栏切换列表视图，选中物品后复制并粘贴；也可每行填写“物品名称 + Tab + 数量”。请核对识别后的名称与数量。",
              "Copy selected items from the in-game inventory list view, or enter item name, Tab, and quantity on each line. Verify every parsed name and quantity.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Label htmlFor="buyback-items" className="sr-only">
            {tr("粘贴待回收物品", "Paste items to sell")}
          </Label>
          <Textarea
            id="buyback-items"
            rows={9}
            maxLength={100000}
            className="font-mono text-sm"
            placeholder={tr(
              "三钛合金\t10000\n类晶体胶矿\t5000",
              "Tritanium\t10000\nPyerite\t5000",
            )}
            value={text}
            disabled={
              !settings?.enabled || configuration.isError || calculate.isPending
            }
            onChange={(event) => setText(event.target.value)}
          />
          {settings && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              {tr("默认规则", "Default")}:{" "}
              {buybackBasisLabel(settings.priceBasis, zh)} ×{" "}
              {settings.ratePercent}% · {tr("报价有效期", "Valid for")}{" "}
              {settings.quoteValidityMinutes} {tr("分钟", "minutes")} ·{" "}
              {settings.defaultEnabled
                ? tr(
                    "默认允许全部物品，类别／单件例外优先。",
                    "All items allowed by default; category and item overrides apply.",
                  )
                : tr(
                    "默认不回收，仅接受规则明确允许的物品。",
                    "Excluded by default; explicit rules may allow items.",
                  )}
            </p>
          )}
          <Button
            disabled={
              !settings?.enabled ||
              configuration.isError ||
              !text.trim() ||
              calculate.isPending
            }
            onClick={submitQuote}
          >
            {calculate.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Calculator className="mr-2 h-4 w-4" />
            )}
            {calculate.isPending
              ? tr("正在获取价格并计算…", "Fetching prices…")
              : tr("计算合同金额", "Calculate contract amount")}
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {tr(
              "每次最多 200 行、80 种物品。行情以吉他 4-4 站为基准：买价取最高买单，卖价取最低卖单，中间价需要双边行情。报价不考虑挂单深度，不保证市场成交。蓝图原图与副本无法仅凭清单可靠区分，所有蓝图均需人工估价；突变装备等非标准属性物品也需管理员单独确认。没有行情的物品会标为待定价，不会悄悄按零元计算。",
              "Up to 200 rows and 80 item types per quote. Prices use Jita 4-4: highest buy, lowest sell, or their midpoint when both sides exist. Quotes ignore order depth and do not guarantee execution. Lists cannot reliably distinguish blueprint originals from copies; all blueprints require manual appraisal, as do mutated or other non-standard items. Missing prices are flagged, never silently treated as zero.",
            )}
          </p>
        </CardContent>
      </Card>
      {result && (
        <Card>
          <CardHeader>
            <CardTitle>{tr("本次报价", "Your quote")}</CardTitle>
            <CardDescription>
              {tr(
                "此结果对应计算时的物品清单和规则快照；网站不会自动创建游戏合同。",
                "This result is a snapshot of the submitted list and rules. The website does not create in-game contracts.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {inputChanged && (
              <p
                role="status"
                className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-200"
              >
                {tr(
                  "输入清单已修改，下方仍是上一次的报价。请重新计算后再复制合同金额。",
                  "The input has changed. The result below is for the previous list; recalculate before copying.",
                )}
              </p>
            )}
            <BuybackQuoteDetails
              quote={result}
              now={now}
              allowCopy={!inputChanged}
            />
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <History className="h-5 w-5" />
            {tr("我的历史报价", "My quote history")}
          </CardTitle>
          <CardDescription>
            {tr(
              "展开查看当时的物品、单价和规则版本。修改规则不会改写旧报价。",
              "Expand a quote to review its items, prices, and rule version. Rule changes never rewrite old quotes.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {history.isLoading ? (
            <p className="text-sm text-muted-foreground">
              {tr("正在加载…", "Loading…")}
            </p>
          ) : history.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {getErrorMessage(history.error)}
            </p>
          ) : (
            <BuybackQuoteHistory
              quotes={history.data?.quotes ?? []}
              now={now}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
