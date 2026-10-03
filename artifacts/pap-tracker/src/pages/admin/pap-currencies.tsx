import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Coins, Loader2, Pencil, Plus, RefreshCw, Search } from "lucide-react";
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
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  type PapCurrency,
  type PapCurrencyInput,
  type PapCurrencyMember,
} from "@/lib/pap-currency-api";
import {
  formatPapDecimal,
  isPositivePapInput,
} from "@/lib/pap-currency-presentation";

const emptyForm = (): PapCurrencyInput => ({
  name: "",
  description: "",
  rate: "",
  issuanceEnabled: true,
  conversionEnabled: true,
});
type Adjustment = Parameters<typeof papCurrencyApi.adjust>[0] & {
  userName: string;
  currencyName: string;
};

export function AdminPapCurrencies() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const admin = useQuery({
    queryKey: papCurrencyKeys.admin,
    queryFn: ({ signal }) => papCurrencyApi.admin(signal),
  });
  const [editing, setEditing] = useState<PapCurrency | null>(null);
  const [form, setForm] = useState<PapCurrencyInput>(emptyForm);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saveUncertain, setSaveUncertain] = useState(false);
  const creationRequest = useRef<{ fingerprint: string; id: string } | null>(
    null,
  );
  const [memberQuery, setMemberQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [member, setMember] = useState<PapCurrencyMember | null>(null);
  const [currencyId, setCurrencyId] = useState("");
  const [direction, setDirection] = useState<"add" | "subtract">("add");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [adjustment, setAdjustment] = useState<Adjustment | null>(null);
  const [adjustUncertain, setAdjustUncertain] = useState(false);
  const adjustmentInFlight = useRef(false);

  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedQuery(memberQuery.trim()),
      300,
    );
    return () => window.clearTimeout(timer);
  }, [memberQuery]);
  const members = useQuery({
    queryKey: papCurrencyKeys.members(debouncedQuery),
    queryFn: ({ signal }) => papCurrencyApi.members(debouncedQuery, signal),
    enabled: debouncedQuery.length >= 1,
  });
  const selectedCurrency = admin.data?.currencies.find(
    (currency) => String(currency.id) === currencyId,
  );
  // Keep a selected member's displayed balance up to date after an adjustment.
  const selectedMember =
    members.data?.members.find((candidate) => candidate.id === member?.id) ??
    member;
  const selectedBalance =
    selectedMember?.wallets.find(
      (wallet) => String(wallet.currencyId) === currencyId,
    )?.balance ?? "0";
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: papCurrencyKeys.all });

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        ...form,
        name: form.name.trim(),
        description: form.description.trim(),
      };
      if (editing)
        return papCurrencyApi.update(editing.id, {
          ...body,
          version: editing.version,
        });
      const fingerprint = JSON.stringify(body);
      if (creationRequest.current?.fingerprint !== fingerprint)
        creationRequest.current = { fingerprint, id: crypto.randomUUID() };
      return papCurrencyApi.create({
        ...body,
        requestId: creationRequest.current.id,
      });
    },
    onSuccess: async () => {
      toast({
        title: editing
          ? tr("PAP 种类已更新", "PAP currency updated")
          : tr("PAP 种类已创建", "PAP currency created"),
      });
      setEditorOpen(false);
      setEditing(null);
      setForm(emptyForm());
      setSaveUncertain(false);
      creationRequest.current = null;
      await refresh();
    },
    onError: async (error) => {
      setSaveUncertain(
        !(
          error instanceof PapCurrencyError &&
          error.status >= 400 &&
          error.status < 500
        ),
      );
      if (error instanceof PapCurrencyError && error.status === 409)
        await refresh();
    },
  });
  const adjust = useMutation({
    mutationFn: (data: Adjustment) =>
      papCurrencyApi.adjust({
        currencyId: data.currencyId,
        userId: data.userId,
        amount: data.amount,
        reason: data.reason,
        version: data.version,
        requestId: data.requestId,
      }),
    onSuccess: async ({ replayed }) => {
      toast({
        title: replayed
          ? tr("已确认之前的调整", "Previous adjustment confirmed")
          : tr("余额已调整", "Balance adjusted"),
      });
      setAdjustment(null);
      setAmount("");
      setReason("");
      setAdjustUncertain(false);
      await refresh();
    },
    onError: async (error) => {
      if (
        error instanceof PapCurrencyError &&
        error.status >= 400 &&
        error.status < 500
      ) {
        setAdjustment(null);
        setAdjustUncertain(false);
        await refresh();
      } else setAdjustUncertain(true);
    },
    onSettled: () => {
      adjustmentInFlight.current = false;
    },
  });
  const openEditor = (currency: PapCurrency | null) => {
    if (save.isPending || saveUncertain) return;
    setEditing(currency);
    setForm(
      currency
        ? {
            name: currency.name,
            description: currency.description,
            rate: currency.rate,
            issuanceEnabled: currency.issuanceEnabled,
            conversionEnabled: currency.conversionEnabled,
          }
        : emptyForm(),
    );
    save.reset();
    creationRequest.current = null;
    setEditorOpen(true);
    window.setTimeout(
      () =>
        document
          .getElementById("pap-currency-editor")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  };
  const changeForm = (patch: Partial<PapCurrencyInput>) => {
    setForm((current) => ({ ...current, ...patch }));
    save.reset();
  };
  const canAdjust = Boolean(
    selectedMember &&
    selectedCurrency &&
    isPositivePapInput(amount) &&
    reason.trim() &&
    (direction === "subtract" || selectedCurrency.issuanceEnabled),
  );

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Coins className="h-6 w-6 text-primary" />
            {tr("PAP 种类管理", "PAP currency management")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              "自行创建种类、编辑比例和管理发放。所有自定义 PAP 只能兑换为通用 PAP。",
              "Create currencies, edit conversion rates and manage issuance. All custom PAP converts only into common PAP.",
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={admin.isFetching || save.isPending || adjust.isPending}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${admin.isFetching ? "animate-spin" : ""}`}
            />
            {tr("刷新", "Refresh")}
          </Button>
          <Button
            disabled={save.isPending || saveUncertain}
            onClick={() => openEditor(null)}
          >
            <Plus className="mr-2 h-4 w-4" />
            {tr("新增种类", "New currency")}
          </Button>
        </div>
      </div>
      <div className="rounded-md border border-border/60 bg-muted/10 p-4 text-sm text-muted-foreground">
        {tr(
          "不预设自定义种类。通用 PAP 沿用现有余额，不能转换为其他种类。种类仅可停用，不提供删除，以保留成员资产和历史流水。",
          "No custom currencies are preset. Existing common PAP cannot be converted into other currencies. Pause currencies instead of deleting them to preserve balances and history.",
        )}
      </div>
      {admin.isLoading && (
        <div className="flex justify-center py-8">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      )}
      {admin.error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          {getErrorMessage(admin.error)}
        </div>
      )}
      {admin.data && (
        <>
          {!admin.data.currencies.length ? (
            <Card>
              <CardContent className="py-8 text-center text-muted-foreground">
                {tr(
                  "尚无自定义 PAP 种类。点击“新增种类”，自行填写名称和兑换比例。",
                  "No custom PAP currencies yet. Choose New currency and define its name and rate.",
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {admin.data.currencies.map((currency) => (
                <Card key={currency.id}>
                  <CardHeader>
                    <div className="flex items-start justify-between gap-3">
                      <CardTitle className="min-w-0 break-words text-lg">
                        {currency.name}
                      </CardTitle>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={save.isPending || saveUncertain}
                        onClick={() => openEditor(currency)}
                      >
                        <Pencil className="mr-2 h-3 w-3" />
                        {tr("编辑", "Edit")}
                      </Button>
                    </div>
                    <CardDescription className="whitespace-pre-wrap break-words">
                      {currency.description ||
                        tr("未填写说明", "No description")}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <p className="break-words font-medium">
                      1 {currency.name} → {formatPapDecimal(currency.rate)}{" "}
                      {tr("通用 PAP", "common PAP")}
                    </p>
                    <PapCurrencyStatus currency={currency} />
                    <p className="text-xs text-muted-foreground">
                      {tr("版本", "Version")} {currency.version} ·{" "}
                      {new Date(currency.updatedAt).toLocaleString()}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
          {editorOpen && (
            <Card id="pap-currency-editor">
              <CardHeader>
                <CardTitle>
                  {editing
                    ? tr("编辑 PAP 种类", "Edit PAP currency")
                    : tr("新增 PAP 种类", "Create PAP currency")}
                </CardTitle>
                <CardDescription>
                  {tr(
                    "修改比例只影响之后的兑换；历史发放、余额和已完成兑换不变。",
                    "Rate changes affect future conversions only; previous issuance, balances and completed conversions remain unchanged.",
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    save.mutate();
                  }}
                >
                  <fieldset
                    disabled={save.isPending || saveUncertain}
                    className="space-y-4"
                  >
                    <div className="grid gap-4 sm:grid-cols-2">
                      <div className="space-y-2">
                        <Label htmlFor="pap-currency-name">
                          {tr("种类名称", "Currency name")}
                        </Label>
                        <Input
                          id="pap-currency-name"
                          required
                          maxLength={40}
                          value={form.name}
                          onChange={(event) =>
                            changeForm({ name: event.target.value })
                          }
                        />
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pap-currency-rate">
                          {tr(
                            "每 1 个此类 PAP 可兑换的通用 PAP",
                            "Common PAP received for 1 unit",
                          )}
                        </Label>
                        <Input
                          id="pap-currency-rate"
                          required
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder={tr(
                            "请自行设置比例",
                            "Set your own rate",
                          )}
                          value={form.rate}
                          onChange={(event) =>
                            changeForm({ rate: event.target.value })
                          }
                        />
                        <p className="text-xs text-muted-foreground">
                          {tr(
                            "大于 0，最高 1,000,000；最多 6 位小数。",
                            "Greater than 0 and at most 1,000,000; up to 6 decimals.",
                          )}
                        </p>
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="pap-currency-description">
                        {tr("说明", "Description")}
                      </Label>
                      <Textarea
                        id="pap-currency-description"
                        maxLength={1000}
                        value={form.description}
                        onChange={(event) =>
                          changeForm({ description: event.target.value })
                        }
                      />
                    </div>
                    <div className="flex flex-wrap gap-6">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="pap-currency-issuance"
                          checked={form.issuanceEnabled}
                          onCheckedChange={(value) =>
                            changeForm({ issuanceEnabled: value === true })
                          }
                        />
                        <Label htmlFor="pap-currency-issuance">
                          {tr("允许发放", "Allow issuance")}
                        </Label>
                      </div>
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="pap-currency-conversion"
                          checked={form.conversionEnabled}
                          onCheckedChange={(value) =>
                            changeForm({ conversionEnabled: value === true })
                          }
                        />
                        <Label htmlFor="pap-currency-conversion">
                          {tr(
                            "允许兑换为通用 PAP",
                            "Allow conversion into common PAP",
                          )}
                        </Label>
                      </div>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {tr(
                        "暂停发放不影响已有余额；暂停兑换会阻止新的兑换。负数纠错仍可由管理员操作。",
                        "Pausing issuance leaves existing balances intact. Pausing conversion blocks new conversions. Administrators may still make negative corrections.",
                      )}
                    </p>
                  </fieldset>
                  {save.error && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
                    >
                      {getErrorMessage(save.error)}
                      {save.error instanceof PapCurrencyError &&
                        save.error.status === 409 && (
                          <p className="mt-2">
                            {tr(
                              "数据发生冲突，请取消编辑并重新打开最新种类；若新增失败，请先核对是否已存在同名种类。",
                              "Data conflict: cancel and reopen the latest currency. If creation failed, first check for an existing currency with the same name.",
                            )}
                          </p>
                        )}
                    </div>
                  )}
                  {saveUncertain && (
                    <p role="alert" className="text-sm text-amber-300">
                      {tr(
                        "服务器结果尚未确认，请重试同一次保存。不要另建重复种类。",
                        "The server result is not confirmed. Retry the same save; do not create a duplicate currency.",
                      )}
                    </p>
                  )}
                  <div className="flex gap-3">
                    <Button
                      type="submit"
                      disabled={
                        save.isPending ||
                        !form.name.trim() ||
                        !isPositivePapInput(form.rate, 1_000_000n)
                      }
                    >
                      {save.isPending && (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      )}
                      {saveUncertain
                        ? tr("重试同一次保存", "Retry same save")
                        : tr("保存种类", "Save currency")}
                    </Button>
                    {!saveUncertain && (
                      <Button
                        variant="outline"
                        disabled={save.isPending}
                        onClick={() => {
                          setEditorOpen(false);
                          save.reset();
                        }}
                      >
                        {tr("取消", "Cancel")}
                      </Button>
                    )}
                  </div>
                </form>
              </CardContent>
            </Card>
          )}

          {admin.data.currencies.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>
                  {tr("发放或调整自定义 PAP", "Issue or adjust custom PAP")}
                </CardTitle>
                <CardDescription>
                  {tr(
                    "仅调整指定成员的指定种类，每次必须填写原因。不会直接改变通用 PAP 或出勤次数。",
                    "Adjust one custom currency for a selected member with a required reason. Common PAP and attendance are not changed directly.",
                  )}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="pap-currency-member-search">
                    {tr("搜索成员", "Search member")}
                  </Label>
                  <div className="relative">
                    <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                    <Input
                      id="pap-currency-member-search"
                      className="pl-9"
                      value={memberQuery}
                      maxLength={80}
                      placeholder={tr("输入角色名", "Enter character name")}
                      disabled={adjust.isPending || !!adjustment}
                      onChange={(event) => {
                        setMemberQuery(event.target.value);
                        setMember(null);
                        adjust.reset();
                      }}
                    />
                  </div>
                </div>
                {members.isFetching && (
                  <p className="text-sm text-muted-foreground">
                    {tr("正在搜索…", "Searching…")}
                  </p>
                )}
                {members.error && (
                  <p role="alert" className="text-sm text-destructive">
                    {getErrorMessage(members.error)}
                  </p>
                )}
                {debouncedQuery &&
                  memberQuery.trim() === debouncedQuery &&
                  !members.isFetching &&
                  !member &&
                  members.data && (
                    <div className="max-h-52 overflow-y-auto rounded-md border border-border/60">
                      {members.data.members.length ? (
                        members.data.members.map((candidate) => (
                          <button
                            type="button"
                            key={candidate.id}
                            className="block w-full border-b border-border/40 px-3 py-2 text-left text-sm last:border-0 hover:bg-primary/10"
                            disabled={!!adjustment}
                            onClick={() => setMember(candidate)}
                          >
                            {candidate.name}{" "}
                            <span className="text-xs text-muted-foreground">
                              #{candidate.id}
                            </span>
                          </button>
                        ))
                      ) : (
                        <p className="p-3 text-sm text-muted-foreground">
                          {tr(
                            "没有匹配的本军团成员。",
                            "No matching corporation member.",
                          )}
                        </p>
                      )}
                    </div>
                  )}
                {selectedMember && (
                  <div className="rounded-md border border-primary/30 bg-primary/5 p-3 text-sm">
                    {tr("已选择", "Selected")}:{" "}
                    <strong>{selectedMember.name}</strong> · #
                    {selectedMember.id}
                    {selectedCurrency && (
                      <p className="mt-1 text-muted-foreground">
                        {selectedCurrency.name} {tr("当前余额", "balance")}:{" "}
                        {formatPapDecimal(selectedBalance)}
                      </p>
                    )}
                  </div>
                )}
                <form
                  className="space-y-4"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (!canAdjust || !selectedCurrency || !selectedMember)
                      return;
                    adjust.reset();
                    setAdjustUncertain(false);
                    setAdjustment({
                      currencyId: selectedCurrency.id,
                      currencyName: selectedCurrency.name,
                      userId: selectedMember.id,
                      userName: selectedMember.name,
                      amount: `${direction === "subtract" ? "-" : ""}${amount}`,
                      reason: reason.trim(),
                      version: selectedCurrency.version,
                      requestId: crypto.randomUUID(),
                    });
                  }}
                >
                  <fieldset
                    disabled={adjust.isPending || !!adjustment}
                    className="space-y-4"
                  >
                    <div className="grid gap-4 sm:grid-cols-3">
                      <div className="space-y-2">
                        <Label htmlFor="pap-adjust-currency">
                          {tr("PAP 种类", "PAP currency")}
                        </Label>
                        <select
                          id="pap-adjust-currency"
                          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          value={currencyId}
                          onChange={(event) => {
                            setCurrencyId(event.target.value);
                            adjust.reset();
                          }}
                        >
                          <option value="">
                            {tr("请选择种类", "Select currency")}
                          </option>
                          {admin.data.currencies.map((currency) => (
                            <option value={currency.id} key={currency.id}>
                              {currency.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pap-adjust-direction">
                          {tr("操作", "Operation")}
                        </Label>
                        <select
                          id="pap-adjust-direction"
                          className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                          value={direction}
                          onChange={(event) => {
                            setDirection(
                              event.target.value as "add" | "subtract",
                            );
                            adjust.reset();
                          }}
                        >
                          <option value="add">
                            {tr("增加／发放", "Add / issue")}
                          </option>
                          <option value="subtract">
                            {tr("扣除／纠错", "Subtract / correct")}
                          </option>
                        </select>
                      </div>
                      <div className="space-y-2">
                        <Label htmlFor="pap-adjust-amount">
                          {tr("数量（填写正数）", "Amount (positive)")}
                        </Label>
                        <Input
                          id="pap-adjust-amount"
                          inputMode="decimal"
                          value={amount}
                          placeholder={tr("最多 6 位小数", "Up to 6 decimals")}
                          onChange={(event) => {
                            setAmount(event.target.value);
                            adjust.reset();
                          }}
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="pap-adjust-reason">
                        {tr("调整原因", "Reason")}
                      </Label>
                      <Textarea
                        id="pap-adjust-reason"
                        required
                        maxLength={500}
                        value={reason}
                        onChange={(event) => {
                          setReason(event.target.value);
                          adjust.reset();
                        }}
                      />
                    </div>
                  </fieldset>
                  {selectedCurrency &&
                    !selectedCurrency.issuanceEnabled &&
                    direction === "add" && (
                      <p className="text-sm text-amber-300">
                        {tr(
                          "此种类已暂停发放；如需发放，请先编辑种类重新开放。",
                          "Issuance is paused. Edit the currency to enable issuance first.",
                        )}
                      </p>
                    )}
                  {amount && !isPositivePapInput(amount) && (
                    <p className="text-sm text-amber-300">
                      {tr(
                        "请输入大于 0、不超过 1,000,000,000 的数量，最多 6 位小数。",
                        "Enter a positive amount of at most 1,000,000,000 with up to 6 decimals.",
                      )}
                    </p>
                  )}
                  {adjust.error && !adjustment && (
                    <div
                      role="alert"
                      className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
                    >
                      {getErrorMessage(adjust.error)}
                      {adjust.error instanceof PapCurrencyError &&
                        adjust.error.status === 409 && (
                          <p className="mt-2">
                            {tr(
                              "请核对最新规则与余额后重新提交。",
                              "Review the latest rules and balance before submitting again.",
                            )}
                          </p>
                        )}
                    </div>
                  )}
                  <Button
                    type="submit"
                    disabled={!canAdjust || adjust.isPending || !!adjustment}
                  >
                    {tr("核对并调整", "Review adjustment")}
                  </Button>
                </form>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>
                {tr("自定义 PAP 管理流水", "Custom PAP management ledger")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "本军团最近的发放、调整和兑换记录；通用 PAP 的原有流水仍在 PAP 账本中。",
                  "Recent corporation issuance, adjustment and conversion records. Existing common PAP transactions remain in the PAP ledger.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <PapCurrencyLedger entries={admin.data.entries} showMember />
            </CardContent>
          </Card>
        </>
      )}
      <AlertDialog
        open={!!adjustment}
        onOpenChange={(open) => {
          if (!open && !adjust.isPending && !adjustUncertain)
            setAdjustment(null);
        }}
      >
        <AlertDialogContent className="max-h-[90vh] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tr("确认调整成员余额", "Confirm member balance adjustment")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tr(
                "确认后立即记账，请核对成员、种类和数量。此操作保留完整流水，不可删除。",
                "This is recorded immediately. Verify the member, currency and amount. The transaction remains in the ledger and cannot be deleted.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {adjustment && (
            <div className="space-y-3 text-sm">
              <p className="break-words">
                {tr("成员", "Member")}: <strong>{adjustment.userName}</strong> ·
                #{adjustment.userId}
              </p>
              <p className="break-words">
                {tr("种类", "Currency")}: {adjustment.currencyName}
              </p>
              <p
                className={`text-xl font-semibold tabular-nums ${adjustment.amount.startsWith("-") ? "text-amber-300" : "text-emerald-400"}`}
              >
                {adjustment.amount.startsWith("-") ? "" : "+"}
                {formatPapDecimal(adjustment.amount)}
              </p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">
                {tr("原因", "Reason")}: {adjustment.reason}
              </p>
            </div>
          )}
          {adjust.error && (
            <p role="alert" className="text-sm text-destructive">
              {getErrorMessage(adjust.error)}
            </p>
          )}
          {adjustUncertain && (
            <p role="alert" className="text-sm text-amber-300">
              {tr(
                "结果尚未确认。重试会使用同一笔请求，不会重复调整。",
                "Result not confirmed. Retrying uses the same request without duplicate adjustment.",
              )}
            </p>
          )}
          <AlertDialogFooter>
            {!adjustUncertain && (
              <Button
                variant="outline"
                disabled={adjust.isPending}
                onClick={() => setAdjustment(null)}
              >
                {tr("取消", "Cancel")}
              </Button>
            )}
            <Button
              disabled={adjust.isPending || !adjustment}
              onClick={() => {
                if (!adjustment || adjustmentInFlight.current) return;
                adjustmentInFlight.current = true;
                adjust.mutate(adjustment);
              }}
            >
              {adjust.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {adjustUncertain
                ? tr("重试同一笔调整", "Retry same adjustment")
                : tr("确认调整", "Confirm adjustment")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
