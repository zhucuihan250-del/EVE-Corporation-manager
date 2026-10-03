import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight, Loader2, RefreshCw, Wallet } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  PapCurrencyLedger,
  PapCurrencyStatus,
} from "@/components/pap-currency-ledger";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import {
  papCurrencyApi,
  papCurrencyKeys,
  PapCurrencyError,
  type PapConversionPreview,
} from "@/lib/pap-currency-api";
import {
  formatPapDecimal,
  hasPapValue,
  isPositivePapInput,
} from "@/lib/pap-currency-presentation";

type Confirmation = PapConversionPreview & { requestId: string };

export function PapWallet() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const wallet = useQuery({
    queryKey: papCurrencyKeys.wallet,
    queryFn: ({ signal }) => papCurrencyApi.wallet(signal),
  });
  const [currencyId, setCurrencyId] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const inFlight = useRef(false);
  const selected = wallet.data?.currencies.find(
    (currency) => String(currency.id) === currencyId,
  );
  const selectedWallet = wallet.data?.wallets.find(
    (entry) => String(entry.currencyId) === currencyId,
  );

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: papCurrencyKeys.all }),
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboardSummary"] }),
      queryClient.invalidateQueries({ queryKey: ["papMarketOverview"] }),
      queryClient.invalidateQueries({ queryKey: ["adminPapRecords"] }),
    ]);
  };
  const preview = useMutation({
    mutationFn: () =>
      papCurrencyApi.preview({ currencyId: Number(currencyId), amount }),
    onSuccess: (data) => {
      setConfirmation({ ...data, requestId: crypto.randomUUID() });
      setUncertain(false);
    },
    onError: () => {
      setConfirmation(null);
    },
  });
  const convert = useMutation({
    mutationFn: (data: Confirmation) =>
      papCurrencyApi.convert({
        currencyId: data.currencyId,
        amount: data.amount,
        version: data.version,
        walletVersion: data.walletVersion,
        requestId: data.requestId,
      }),
    onSuccess: async ({ entry, replayed }) => {
      setConfirmation(null);
      setAmount("");
      setUncertain(false);
      toast({
        title: replayed
          ? tr("已确认之前的兑换", "Previous conversion confirmed")
          : tr("兑换完成", "Conversion completed"),
        description: `+${formatPapDecimal(entry.commonAmount)} ${tr("通用 PAP", "common PAP")}`,
      });
      await invalidate();
    },
    onError: async (error) => {
      if (
        error instanceof PapCurrencyError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        setConfirmation(null);
        setUncertain(false);
        await invalidate();
      } else {
        // Keep the original idempotency key when the server result is unknown.
        setUncertain(true);
      }
    },
    onSettled: () => {
      inFlight.current = false;
    },
  });
  const resetPreview = () => {
    setConfirmation(null);
    preview.reset();
    convert.reset();
    setUncertain(false);
  };
  const busy = preview.isPending || convert.isPending;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Wallet className="h-6 w-6 text-primary" />
            {tr("PAP 钱包", "PAP wallet")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              "自定义 PAP 独立持有，只能单向兑换为通用 PAP。",
              "Hold custom PAP separately and convert it one-way into common PAP.",
            )}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={busy || wallet.isFetching}
          onClick={() => {
            if (!uncertain) resetPreview();
            void invalidate();
          }}
        >
          <RefreshCw
            className={`mr-2 h-4 w-4 ${wallet.isFetching ? "animate-spin" : ""}`}
          />
          {tr("刷新余额与流水", "Refresh balances and ledger")}
        </Button>
      </div>
      {wallet.isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      )}
      {wallet.error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          {getErrorMessage(wallet.error)}
        </div>
      )}
      {wallet.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{tr("通用 PAP", "Common PAP")}</CardTitle>
              <CardDescription>
                {tr(
                  "原有 PAP 余额沿用；奖励兑换、PAP Market 和月度扣除继续使用通用 PAP。",
                  "Your existing balance is preserved. Rewards, PAP Market and monthly deductions continue to use common PAP.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-3">
                {[
                  [tr("可用余额", "Available"), wallet.data.common.available],
                  [tr("冻结余额", "Locked"), wallet.data.common.locked],
                  [
                    tr("总余额（含冻结）", "Total including locked"),
                    wallet.data.common.balance,
                  ],
                ].map(([label, value], index) => (
                  <div
                    key={label}
                    className="min-w-0 rounded-md border border-border/50 p-4"
                  >
                    <div className="text-xs text-muted-foreground">{label}</div>
                    <div
                      className={`mt-2 break-all text-2xl font-semibold tabular-nums ${index === 0 ? "text-primary" : ""}`}
                    >
                      {formatPapDecimal(value)}
                    </div>
                  </div>
                ))}
              </div>
              <Link
                className="mt-4 inline-block text-sm text-primary underline-offset-4 hover:underline"
                href="/history"
              >
                {tr("查看 PAP 发放记录", "View PAP award history")}
              </Link>
            </CardContent>
          </Card>
          {!wallet.data.currencies.length ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {tr(
                  "管理员尚未创建自定义 PAP 种类。通用 PAP 可继续正常使用。",
                  "No custom PAP currencies have been created by administrators. Common PAP remains available.",
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {wallet.data.currencies.map((currency) => {
                  const balance = wallet.data.wallets.find(
                    (entry) => entry.currencyId === currency.id,
                  );
                  return (
                    <Card key={currency.id}>
                      <CardHeader>
                        <CardTitle className="break-words text-lg">
                          {currency.name}
                        </CardTitle>
                        <CardDescription className="whitespace-pre-wrap break-words">
                          {currency.description ||
                            tr("未填写说明", "No description")}
                        </CardDescription>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="break-all text-2xl font-semibold tabular-nums">
                          {formatPapDecimal(balance?.balance ?? "0")}
                        </div>
                        <PapCurrencyStatus currency={currency} />
                        <p className="text-sm text-muted-foreground">
                          1 {currency.name}{" "}
                          <ArrowRight className="inline h-3 w-3" />{" "}
                          {formatPapDecimal(currency.rate)}{" "}
                          {tr("通用 PAP", "common PAP")}
                        </p>
                        {balance && hasPapValue(balance.carry) && (
                          <p className="break-all text-xs text-muted-foreground">
                            {tr("保留兑换尾数", "Saved conversion carry")}:{" "}
                            {formatPapDecimal(balance.carry)}{" "}
                            {tr("通用 PAP", "common PAP")}
                          </p>
                        )}
                        <Button
                          className="w-full"
                          variant="outline"
                          disabled={
                            !currency.conversionEnabled ||
                            !hasPapValue(balance?.balance ?? "0") ||
                            busy ||
                            uncertain
                          }
                          onClick={() => {
                            resetPreview();
                            setCurrencyId(String(currency.id));
                            setAmount("");
                            document
                              .getElementById("pap-conversion")
                              ?.scrollIntoView({
                                behavior: "smooth",
                                block: "start",
                              });
                          }}
                        >
                          {tr("选择兑换", "Select for conversion")}
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
              <Card id="pap-conversion">
                <CardHeader>
                  <CardTitle>
                    {tr("兑换为通用 PAP", "Convert to common PAP")}
                  </CardTitle>
                  <CardDescription>
                    {tr(
                      "不可反向兑换或在自定义种类之间互换。数量与余额保留 6 位小数，更小的尾数保留至同一种类的后续兑换。",
                      "No reverse or cross-currency conversion. Amounts and balances use 6 decimals; smaller remainders carry forward for future conversions of the same currency.",
                    )}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                  <form
                    className="grid items-end gap-4 sm:grid-cols-[1fr_1fr_auto]"
                    onSubmit={(event) => {
                      event.preventDefault();
                      resetPreview();
                      preview.mutate();
                    }}
                  >
                    <div className="space-y-2">
                      <Label htmlFor="pap-conversion-currency">
                        {tr("PAP 种类", "PAP currency")}
                      </Label>
                      <select
                        id="pap-conversion-currency"
                        className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                        value={currencyId}
                        disabled={busy || uncertain}
                        onChange={(event) => {
                          resetPreview();
                          setCurrencyId(event.target.value);
                          setAmount("");
                        }}
                      >
                        <option value="">
                          {tr("请选择种类", "Select a currency")}
                        </option>
                        {wallet.data.currencies.map((currency) => (
                          <option
                            key={currency.id}
                            value={currency.id}
                            disabled={!currency.conversionEnabled}
                          >
                            {currency.name}
                            {currency.conversionEnabled
                              ? ""
                              : tr("（暂停兑换）", " (conversion paused)")}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="pap-conversion-amount">
                        {tr("兑换数量", "Amount to convert")}
                      </Label>
                      <Input
                        id="pap-conversion-amount"
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={tr(
                          "最多 6 位小数",
                          "Up to 6 decimal places",
                        )}
                        value={amount}
                        disabled={busy || uncertain}
                        onChange={(event) => {
                          resetPreview();
                          setAmount(event.target.value);
                        }}
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={
                        busy ||
                        uncertain ||
                        !selected?.conversionEnabled ||
                        !isPositivePapInput(amount)
                      }
                    >
                      {preview.isPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {tr("预览兑换", "Preview conversion")}
                    </Button>
                  </form>
                  {selected && (
                    <p className="text-sm text-muted-foreground">
                      {tr("当前持有", "Current balance")}:{" "}
                      {formatPapDecimal(selectedWallet?.balance ?? "0")}{" "}
                      {selected.name}
                    </p>
                  )}
                  {amount && !isPositivePapInput(amount) && (
                    <p className="text-sm text-amber-300">
                      {tr(
                        "请输入大于 0、不超过 1,000,000,000 的数量，最多 6 位小数；不要使用千位逗号或科学计数法。",
                        "Enter a positive decimal of at most 1,000,000,000 with up to 6 places, without grouping commas or scientific notation.",
                      )}
                    </p>
                  )}
                  {(preview.error || convert.error) && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
                    >
                      {getErrorMessage(convert.error ?? preview.error)}
                      {convert.error instanceof PapCurrencyError &&
                        convert.error.status === 409 && (
                          <p className="mt-2">
                            {tr(
                              "余额或规则可能已改变，请重新预览。",
                              "Balances or rules may have changed. Please preview again.",
                            )}
                          </p>
                        )}
                    </div>
                  )}
                  {confirmation && (
                    <div
                      className="space-y-4 rounded-md border border-primary/30 bg-primary/5 p-4"
                      aria-live="polite"
                    >
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <p className="text-xs text-muted-foreground">
                            {tr("将扣除", "You will spend")}
                          </p>
                          <p className="mt-1 break-words text-lg font-semibold">
                            {formatPapDecimal(confirmation.amount)}{" "}
                            {confirmation.currencyName}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-muted-foreground">
                            {tr("将到账", "You will receive")}
                          </p>
                          <p className="mt-1 break-words text-lg font-semibold text-primary">
                            {formatPapDecimal(confirmation.commonAmount)}{" "}
                            {tr("通用 PAP", "common PAP")}
                          </p>
                        </div>
                      </div>
                      <div className="space-y-1 text-xs text-muted-foreground">
                        <p>
                          {tr("本次比例", "Rate")}: 1 :{" "}
                          {formatPapDecimal(confirmation.rate)} ·{" "}
                          {tr("兑换后该种类余额", "Remaining custom balance")}:{" "}
                          {formatPapDecimal(confirmation.balanceAfter)}
                        </p>
                        <p className="break-all">
                          {tr("兑换前尾数", "Previous carry")}:{" "}
                          {formatPapDecimal(confirmation.carryBefore)} →{" "}
                          {tr("兑换后保留尾数", "Saved carry")}:{" "}
                          {formatPapDecimal(confirmation.carryAfter)}{" "}
                          {tr("通用 PAP", "common PAP")}
                        </p>
                      </div>
                      <p className="text-sm text-amber-300">
                        {tr(
                          "确认后立即扣除并到账，不能撤回或反向兑换。比例或余额变更时必须重新预览。",
                          "Confirmation deducts and credits immediately. This cannot be reversed. A changed rate or balance requires a new preview.",
                        )}
                      </p>
                      {uncertain && (
                        <p role="alert" className="text-sm text-amber-300">
                          {tr(
                            "尚未确认服务器结果。请使用下方按钮重试同一笔兑换，不会重复扣款；也可以先刷新上方余额与下方流水核对。",
                            "The server result is not yet confirmed. Retry the same request below without duplicate deduction, or refresh balances and the ledger to check.",
                          )}
                        </p>
                      )}
                      <div className="flex flex-wrap gap-3">
                        <Button
                          disabled={busy}
                          onClick={() => {
                            if (inFlight.current) return;
                            inFlight.current = true;
                            convert.mutate(confirmation);
                          }}
                        >
                          {convert.isPending && (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          )}
                          {uncertain
                            ? tr(
                                "重试并确认同一笔兑换",
                                "Retry the same conversion",
                              )
                            : tr(
                                "确认兑换，不可撤回",
                                "Confirm irreversible conversion",
                              )}
                        </Button>
                        {!uncertain && (
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={resetPreview}
                          >
                            {tr("取消", "Cancel")}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                {tr("自定义 PAP 流水", "Custom PAP ledger")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "显示最近记录；兑换保留当时的种类名称、比例和到账数量，不受后续编辑影响。",
                  "Recent transactions preserve the currency name, rate and credited amount at the time of conversion.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PapCurrencyLedger entries={wallet.data.entries} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
