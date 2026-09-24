import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Calculator,
  History,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Settings2,
  Trash2,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import {
  buybackApi,
  buybackBasisLabel,
  buybackKeys,
  formatBuybackIsk,
  type BuybackAdminData,
  type BuybackCatalogItem,
  type BuybackConfiguration,
  type BuybackPriceBasis,
  type BuybackRule,
  type BuybackRuleInput,
  type BuybackSettings,
} from "@/lib/buyback-api";
import { BuybackQuoteHistory } from "@/pages/buyback";

const selectClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 text-sm";
const pricePattern = "[0-9]{1,16}([.][0-9]{1,2})?";
const bases: BuybackPriceBasis[] = ["buy", "sell", "mid", "fixed"];
type Translate = (cn: string, en: string) => string;

type SettingsDraft = Omit<
  BuybackSettings,
  "ratePercent" | "fixedPrice" | "quoteValidityMinutes"
> & {
  ratePercent: string;
  fixedPrice: string;
  quoteValidityMinutes: string;
};
const settingsDraft = (settings: BuybackSettings): SettingsDraft => ({
  ...settings,
  ratePercent: String(settings.ratePercent),
  fixedPrice: settings.fixedPrice ?? "",
  quoteValidityMinutes: String(settings.quoteValidityMinutes),
});

function GlobalSettings({
  settings,
  pending,
  save,
  tr,
  zh,
}: {
  settings: BuybackSettings;
  pending: boolean;
  save: (settings: BuybackSettings) => void;
  tr: Translate;
  zh: boolean;
}) {
  const [draft, setDraft] = useState(() => settingsDraft(settings));
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (!dirty) setDraft(settingsDraft(settings));
  }, [settings, dirty]);
  const stale = dirty && draft.version !== settings.version;
  const change = (patch: Partial<SettingsDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setDirty(true);
  };
  const reset = () => {
    setDraft(settingsDraft(settings));
    setDirty(false);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (stale || pending) return;
    save({
      ...draft,
      ratePercent: Number(draft.ratePercent),
      fixedPrice: draft.fixedPrice.trim() || null,
      quoteValidityMinutes: Number(draft.quoteValidityMinutes),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Settings2 className="h-5 w-5" />
          {tr("全局回收设置", "Global buyback settings")}
        </CardTitle>
        <CardDescription>
          {tr(
            "单件物品 → 类别 → 全局默认，逐项继承。修改只影响新报价，旧报价保留原价格和有效期。",
            "Each field inherits from item to category to global default. Changes affect new quotes only; existing quotes retain their prices and expiry.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={submit}>
          {stale && (
            <div
              role="alert"
              className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              {tr(
                "规则已有更新。为避免覆盖其他修改，请先重新载入设置，再进行编辑。未保存的内容仍保留在下方。",
                "Rules have changed. Reload settings before editing to avoid overwriting other changes. Your unsaved draft is still shown below.",
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-2 block"
                onClick={reset}
              >
                {tr("放弃草稿并载入最新设置", "Discard draft and reload")}
              </Button>
            </div>
          )}
          <fieldset
            disabled={pending}
            className="space-y-5 disabled:opacity-60"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-4">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={draft.enabled}
                  onChange={(event) =>
                    change({ enabled: event.target.checked })
                  }
                />
                <span>
                  <span className="font-medium">
                    {tr("开放回收计算器", "Enable buyback quoting")}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {tr(
                      "保存后生效。关闭时不能生成新报价，历史记录仍可查看。",
                      "Takes effect after saving. Pausing blocks new quotes but retains history.",
                    )}
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/60 p-4">
                <input
                  type="checkbox"
                  className="mt-1 accent-primary"
                  checked={draft.defaultEnabled}
                  onChange={(event) =>
                    change({ defaultEnabled: event.target.checked })
                  }
                />
                <span>
                  <span className="font-medium">
                    {tr("默认允许全部物品回收", "Allow all items by default")}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {tr(
                      "类别和单件物品可单独排除。无价格或特殊属性物品仍需人工处理。",
                      "Categories and individual items may be excluded. Unpriced and attribute-dependent items still need review.",
                    )}
                  </span>
                </span>
              </label>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="buyback-global-basis">
                  {tr("默认价格基准", "Default price basis")}
                </Label>
                <select
                  id="buyback-global-basis"
                  className={selectClass}
                  value={draft.priceBasis}
                  onChange={(event) =>
                    change({
                      priceBasis: event.target.value as BuybackPriceBasis,
                    })
                  }
                >
                  {bases.map((basis) => (
                    <option key={basis} value={basis}>
                      {buybackBasisLabel(basis, zh)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="buyback-global-rate">
                  {tr("默认回收比例（%）", "Default buyback rate (%)")}
                </Label>
                <Input
                  id="buyback-global-rate"
                  type="number"
                  min="0.01"
                  max="1000"
                  step="0.01"
                  required
                  value={draft.ratePercent}
                  onChange={(event) =>
                    change({ ratePercent: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "例如填写 90，即参考价格的 90%；固定单价也会乘以此比例。",
                    "Enter 90 for 90% of the reference price. This rate also applies to fixed prices.",
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="buyback-global-fixed">
                  {tr(
                    "默认固定参考单价（ISK）",
                    "Default fixed reference price (ISK)",
                  )}
                </Label>
                <Input
                  id="buyback-global-fixed"
                  inputMode="decimal"
                  pattern={pricePattern}
                  required={draft.priceBasis === "fixed"}
                  maxLength={19}
                  value={draft.fixedPrice}
                  onChange={(event) =>
                    change({ fixedPrice: event.target.value })
                  }
                  placeholder={tr(
                    "使用固定价时必填，其他情况可留空",
                    "Required for fixed pricing, optional otherwise",
                  )}
                />
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "大于 0，最多两位小数。不含千位分隔符；仅在有效价格基准为固定价时使用。",
                    "Positive amount, up to 2 decimal places, no grouping separators. Used only when the effective basis is fixed.",
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="buyback-global-validity">
                  {tr("报价有效期（分钟）", "Quote validity (minutes)")}
                </Label>
                <Input
                  id="buyback-global-validity"
                  type="number"
                  min="1"
                  max="1440"
                  step="1"
                  required
                  value={draft.quoteValidityMinutes}
                  onChange={(event) =>
                    change({ quoteValidityMinutes: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "1–1440 分钟，过期后成员必须重新计算。",
                    "1–1440 minutes. Members must recalculate after expiry.",
                  )}
                </p>
              </div>
            </div>
          </fieldset>
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={pending || stale || !dirty}>
              {pending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-2 h-4 w-4" />
              )}
              {tr("保存全局设置", "Save global settings")}
            </Button>
            {dirty && (
              <Button
                type="button"
                variant="outline"
                disabled={pending}
                onClick={reset}
              >
                {tr("撤销未保存修改", "Discard changes")}
              </Button>
            )}
            <span className="text-xs text-muted-foreground">
              {tr("当前规则版本", "Current rule version")} {settings.version} ·{" "}
              {settings.enabled
                ? tr("已开放", "Enabled")
                : tr("已暂停", "Paused")}
            </span>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

type RuleDraft = {
  id: number | null;
  scope: "category" | "type";
  target: BuybackCatalogItem | null;
  enabled: "inherit" | "allow" | "exclude";
  priceBasis: BuybackPriceBasis | "inherit";
  ratePercent: string;
  fixedPrice: string;
  version: number;
};

function RuleEditor({
  initial,
  version,
  pending,
  onSave,
  onClose,
  tr,
  zh,
}: {
  initial: RuleDraft;
  version: number;
  pending: boolean;
  onSave: (
    id: number | null,
    input: BuybackRuleInput & { version: number },
  ) => void;
  onClose: () => void;
  tr: Translate;
  zh: boolean;
}) {
  const [draft, setDraft] = useState(initial);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);
  const catalog = useQuery({
    queryKey: buybackKeys.catalog(draft.scope, search),
    queryFn: ({ signal }) => buybackApi.catalog(draft.scope, search, signal),
    enabled: !draft.target && (draft.scope === "category" || search.length > 0),
  });
  const stale = draft.version !== version;
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.target || stale || pending) return;
    onSave(draft.id, {
      scope: draft.scope,
      targetId: draft.target.id,
      enabled: draft.enabled === "inherit" ? null : draft.enabled === "allow",
      priceBasis: draft.priceBasis === "inherit" ? null : draft.priceBasis,
      ratePercent: draft.ratePercent.trim() ? Number(draft.ratePercent) : null,
      fixedPrice: draft.fixedPrice.trim() || null,
      version: draft.version,
    });
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {draft.id === null
              ? tr("新增回收规则", "Add buyback rule")
              : tr("编辑回收规则", "Edit buyback rule")}
          </DialogTitle>
          <DialogDescription>
            {tr(
              "只覆盖需要调整的字段；选择“继承上级”或留空，将使用类别／全局对应设置。",
              "Override only the fields you need. Choose Inherit or leave a field empty to use category or global settings.",
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="space-y-4" onSubmit={submit}>
          {stale && (
            <p
              role="alert"
              className="rounded-md bg-amber-500/10 p-3 text-sm text-amber-200"
            >
              {tr(
                "规则在编辑期间已更新，请关闭此窗口后重新编辑，避免覆盖其他修改。",
                "Rules changed while this editor was open. Close and reopen it before saving.",
              )}
            </p>
          )}
          <fieldset
            disabled={pending}
            className="space-y-4 disabled:opacity-60"
          >
            <div className="space-y-2">
              <Label htmlFor="buyback-rule-scope">
                {tr("规则对象", "Rule scope")}
              </Label>
              <select
                id="buyback-rule-scope"
                className={selectClass}
                value={draft.scope}
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    scope: event.target.value as RuleDraft["scope"],
                    target: null,
                  });
                  setQuery("");
                  setSearch("");
                }}
              >
                <option value="category">{tr("物品类别", "Category")}</option>
                <option value="type">
                  {tr("单件物品", "Individual item")}
                </option>
              </select>
            </div>
            {draft.target ? (
              <div className="flex items-start justify-between gap-3 rounded-md border border-primary/30 bg-primary/5 p-3">
                <div className="min-w-0">
                  <div className="break-words font-medium">
                    {draft.target.name}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {draft.target.nameEn &&
                    draft.target.nameEn !== draft.target.name
                      ? `${draft.target.nameEn} · `
                      : ""}
                    ID {draft.target.id}
                    {draft.target.categoryName
                      ? ` · ${draft.target.categoryName}`
                      : ""}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft({ ...draft, target: null });
                    setQuery("");
                    setSearch("");
                  }}
                >
                  {tr("更换", "Change")}
                </Button>
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="buyback-rule-search">
                  {draft.scope === "category"
                    ? tr("搜索类别", "Search categories")
                    : tr("搜索物品", "Search items")}
                </Label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    id="buyback-rule-search"
                    className="pl-9"
                    value={query}
                    maxLength={100}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={tr(
                      "输入中文、英文名称或编号",
                      "Chinese or English name, or ID",
                    )}
                    autoComplete="off"
                  />
                </div>
                <div
                  className="max-h-48 overflow-y-auto rounded-md border border-border/60"
                  aria-label={tr("搜索结果", "Search results")}
                >
                  {catalog.isFetching || query.trim() !== search ? (
                    <p
                      role="status"
                      className="p-3 text-sm text-muted-foreground"
                    >
                      {tr("搜索中…", "Searching…")}
                    </p>
                  ) : catalog.isError ? (
                    <p role="alert" className="p-3 text-sm text-destructive">
                      {getErrorMessage(catalog.error)}
                    </p>
                  ) : !catalog.data?.items.length ? (
                    <p className="p-3 text-sm text-muted-foreground">
                      {draft.scope === "type" && !search
                        ? tr(
                            "请输入物品名称进行搜索。",
                            "Enter an item name to search.",
                          )
                        : tr(
                            "没有匹配结果，请尝试其他名称。",
                            "No matches. Try a different name.",
                          )}
                    </p>
                  ) : (
                    catalog.data.items.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        className="block w-full border-b border-border/40 p-3 text-left text-sm last:border-b-0 hover:bg-muted/40 focus-visible:bg-muted/40"
                        onClick={() => setDraft({ ...draft, target: item })}
                      >
                        <span className="block font-medium">{item.name}</span>
                        <span className="mt-1 block text-xs text-muted-foreground">
                          {item.nameEn && item.nameEn !== item.name
                            ? `${item.nameEn} · `
                            : ""}
                          ID {item.id}
                          {item.categoryName ? ` · ${item.categoryName}` : ""}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="buyback-rule-enabled">
                  {tr("是否回收", "Acceptance")}
                </Label>
                <select
                  id="buyback-rule-enabled"
                  className={selectClass}
                  value={draft.enabled}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      enabled: event.target.value as RuleDraft["enabled"],
                    })
                  }
                >
                  <option value="inherit">{tr("继承上级", "Inherit")}</option>
                  <option value="allow">{tr("允许回收", "Allow")}</option>
                  <option value="exclude">{tr("不回收", "Exclude")}</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="buyback-rule-basis">
                  {tr("价格基准", "Price basis")}
                </Label>
                <select
                  id="buyback-rule-basis"
                  className={selectClass}
                  value={draft.priceBasis}
                  onChange={(event) =>
                    setDraft({
                      ...draft,
                      priceBasis: event.target.value as RuleDraft["priceBasis"],
                    })
                  }
                >
                  <option value="inherit">{tr("继承上级", "Inherit")}</option>
                  {bases.map((basis) => (
                    <option key={basis} value={basis}>
                      {buybackBasisLabel(basis, zh)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="buyback-rule-rate">
                  {tr("回收比例（%）", "Buyback rate (%)")}
                </Label>
                <Input
                  id="buyback-rule-rate"
                  type="number"
                  min="0.01"
                  max="1000"
                  step="0.01"
                  value={draft.ratePercent}
                  onChange={(event) =>
                    setDraft({ ...draft, ratePercent: event.target.value })
                  }
                  placeholder={tr("留空继承上级", "Leave empty to inherit")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="buyback-rule-fixed">
                  {tr("固定参考单价（ISK）", "Fixed reference price (ISK)")}
                </Label>
                <Input
                  id="buyback-rule-fixed"
                  inputMode="decimal"
                  pattern={pricePattern}
                  maxLength={19}
                  value={draft.fixedPrice}
                  onChange={(event) =>
                    setDraft({ ...draft, fixedPrice: event.target.value })
                  }
                  placeholder={tr("留空继承上级", "Leave empty to inherit")}
                />
              </div>
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {tr(
                "比例范围 0.01–1000%，最多两位小数。固定价必须大于 0，且仍乘以回收比例；仅在有效基准为固定价时使用。若最终无法获得价格，成员会看到“待定价”，不会按零元收购。",
                "Rate: 0.01–1000%, up to 2 decimals. A fixed price must be positive and is still multiplied by the rate; it is used only with a fixed basis. If no effective price exists, the item is marked unpriced, never bought at zero.",
              )}
            </p>
          </fieldset>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {tr("取消", "Cancel")}
            </Button>
            <Button type="submit" disabled={pending || stale || !draft.target}>
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {tr("保存规则", "Save rule")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function AdminBuyback() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr: Translate = (cn, en) => (zh ? cn : en);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const admin = useQuery({
    queryKey: buybackKeys.admin,
    queryFn: ({ signal }) => buybackApi.admin(signal),
  });
  const [now, setNow] = useState(Date.now);
  const [editor, setEditor] = useState<RuleDraft | null>(null);
  const [deleting, setDeleting] = useState<{
    rule: BuybackRule;
    version: number;
  } | null>(null);
  const [filter, setFilter] = useState("");
  const [scope, setScope] = useState("all");
  const [visibleCount, setVisibleCount] = useState(20);
  const [settingsSaved, setSettingsSaved] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const applyConfiguration = (configuration: BuybackConfiguration) => {
    queryClient.setQueryData(buybackKeys.settings, configuration);
    queryClient.setQueryData<BuybackAdminData>(buybackKeys.admin, (previous) =>
      previous ? { ...previous, ...configuration } : undefined,
    );
    void queryClient.invalidateQueries({ queryKey: buybackKeys.admin });
  };
  const failure = (error: unknown) => {
    toast({
      title: tr("保存失败", "Save failed"),
      description: getErrorMessage(error),
      variant: "destructive",
    });
    void queryClient.invalidateQueries({ queryKey: buybackKeys.admin });
  };
  const saveSettings = useMutation({
    mutationFn: buybackApi.saveSettings,
    onSuccess: (configuration) => {
      applyConfiguration(configuration);
      setSettingsSaved((value) => value + 1);
      toast({ title: tr("全局回收设置已保存", "Global settings saved") });
    },
    onError: failure,
  });
  const saveRule = useMutation({
    mutationFn: ({
      id,
      input,
    }: {
      id: number | null;
      input: BuybackRuleInput & { version: number };
    }) => buybackApi.saveRule(id, input),
    onSuccess: (configuration) => {
      applyConfiguration(configuration);
      setEditor(null);
      toast({ title: tr("回收规则已保存", "Rule saved") });
    },
    onError: failure,
  });
  const deleteRule = useMutation({
    mutationFn: ({ rule, version }: { rule: BuybackRule; version: number }) =>
      buybackApi.deleteRule(rule.id, version),
    onSuccess: (configuration) => {
      applyConfiguration(configuration);
      setDeleting(null);
      toast({
        title: tr(
          "规则已移除，恢复继承上级设置",
          "Rule removed; parent settings apply",
        ),
      });
    },
    onError: (error) => {
      setDeleting(null);
      failure(error);
    },
  });
  const pending =
    saveSettings.isPending || saveRule.isPending || deleteRule.isPending;
  const data = admin.data;
  const filtered = useMemo(
    () =>
      (data?.rules ?? []).filter(
        (rule) =>
          (scope === "all" || rule.scope === scope) &&
          `${rule.targetName ?? ""} ${rule.targetNameEn ?? ""} ${rule.targetId}`
            .toLocaleLowerCase()
            .includes(filter.trim().toLocaleLowerCase()),
      ),
    [data?.rules, scope, filter],
  );
  const editRule = (rule?: BuybackRule) => {
    if (!data) return;
    setEditor({
      id: rule?.id ?? null,
      scope: rule?.scope ?? "category",
      target: rule
        ? {
            id: rule.targetId,
            name: rule.targetName || `ID ${rule.targetId}`,
            nameEn: rule.targetNameEn,
          }
        : null,
      enabled:
        rule?.enabled == null ? "inherit" : rule.enabled ? "allow" : "exclude",
      priceBasis: rule?.priceBasis ?? "inherit",
      ratePercent: rule?.ratePercent == null ? "" : String(rule.ratePercent),
      fixedPrice: rule?.fixedPrice ?? "",
      version: data.settings.version,
    });
  };

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Calculator className="h-6 w-6 text-primary" />
            {tr("回收管理", "Buyback management")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              "为本站军团设置回收范围和计价规则，核对成员的报价记录。",
              "Configure this corporation's acceptance and pricing rules, and review member quotes.",
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/buyback">{tr("打开计算器", "Open calculator")}</Link>
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={pending || admin.isFetching}
            onClick={() =>
              queryClient.invalidateQueries({ queryKey: buybackKeys.all })
            }
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {tr("刷新", "Refresh")}
          </Button>
        </div>
      </div>
      {admin.isLoading && (
        <p
          role="status"
          className="flex items-center gap-2 text-muted-foreground"
        >
          <Loader2 className="h-4 w-4 animate-spin" />
          {tr("正在加载回收管理…", "Loading buyback administration…")}
        </p>
      )}
      {admin.isError && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 p-4 text-sm text-destructive"
        >
          {getErrorMessage(admin.error)}
        </p>
      )}
      {data && (
        <>
          <GlobalSettings
            key={settingsSaved}
            settings={data.settings}
            pending={pending || admin.isError}
            save={(settings) => saveSettings.mutate(settings)}
            tr={tr}
            zh={zh}
          />
          <Card>
            <CardHeader>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <CardTitle>
                  {tr("类别与单件物品规则", "Category and item overrides")}
                </CardTitle>
                <Button
                  size="sm"
                  disabled={pending || admin.isError}
                  onClick={() => editRule()}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  {tr("新增规则", "Add rule")}
                </Button>
              </div>
              <CardDescription>
                {tr(
                  "单件规则优先于类别规则。删除规则表示恢复继承，不等于禁止回收；要停止回收，请编辑并选择“不回收”。",
                  "Item overrides take priority over category overrides. Deleting restores inheritance; it does not exclude the item. To stop buying an item, edit its rule and choose Exclude.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-3 sm:flex-row">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                  <Input
                    aria-label={tr("筛选已有规则", "Filter configured rules")}
                    className="pl-9"
                    value={filter}
                    onChange={(event) => {
                      setFilter(event.target.value);
                      setVisibleCount(20);
                    }}
                    placeholder={tr(
                      "搜索已配置的名称或编号",
                      "Find a configured name or ID",
                    )}
                  />
                </div>
                <select
                  aria-label={tr("规则类型", "Rule type")}
                  className={`${selectClass} sm:w-44`}
                  value={scope}
                  onChange={(event) => {
                    setScope(event.target.value);
                    setVisibleCount(20);
                  }}
                >
                  <option value="all">{tr("全部规则", "All rules")}</option>
                  <option value="category">
                    {tr("类别规则", "Categories")}
                  </option>
                  <option value="type">{tr("单件规则", "Items")}</option>
                </select>
              </div>
              {!filtered.length ? (
                <p className="py-3 text-sm text-muted-foreground">
                  {data.rules.length
                    ? tr("没有匹配的规则。", "No matching rules.")
                    : tr(
                        "尚未添加例外规则，全部物品使用全局默认设置。",
                        "No overrides yet. All items use the global defaults.",
                      )}
                </p>
              ) : (
                <div className="space-y-3">
                  {filtered.slice(0, visibleCount).map((rule) => (
                    <div
                      key={rule.id}
                      className="flex flex-col justify-between gap-3 rounded-lg border border-border/60 p-4 lg:flex-row lg:items-center"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="break-words font-medium">
                            {rule.targetName || `ID ${rule.targetId}`}
                          </span>
                          <Badge variant="outline">
                            {rule.scope === "type"
                              ? tr("单件", "Item")
                              : tr("类别", "Category")}
                          </Badge>
                          <Badge
                            variant={
                              rule.enabled === false
                                ? "destructive"
                                : "secondary"
                            }
                          >
                            {rule.enabled === null
                              ? tr("回收状态继承", "Acceptance inherited")
                              : rule.enabled
                                ? tr("允许回收", "Allowed")
                                : tr("不回收", "Excluded")}
                          </Badge>
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                          ID {rule.targetId} · {tr("基准", "Basis")}:{" "}
                          {buybackBasisLabel(rule.priceBasis, zh)} ·{" "}
                          {tr("比例", "Rate")}:{" "}
                          {rule.ratePercent === null
                            ? tr("继承", "Inherit")
                            : `${rule.ratePercent}%`}{" "}
                          · {tr("固定价", "Fixed")}:{" "}
                          {rule.fixedPrice === null
                            ? tr("继承", "Inherit")
                            : formatBuybackIsk(rule.fixedPrice)}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending || admin.isError}
                          aria-label={`${tr("编辑", "Edit")} ${rule.targetName || rule.targetId}`}
                          onClick={() => editRule(rule)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          {tr("编辑", "Edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive"
                          disabled={pending || admin.isError}
                          aria-label={`${tr("删除", "Delete")} ${rule.targetName || rule.targetId}`}
                          onClick={() =>
                            setDeleting({
                              rule,
                              version: data.settings.version,
                            })
                          }
                        >
                          <Trash2 className="mr-2 h-4 w-4" />
                          {tr("删除", "Delete")}
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                <span>
                  {tr("匹配规则", "Matching rules")}: {filtered.length} /{" "}
                  {data.rules.length}
                </span>
                {visibleCount < filtered.length && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setVisibleCount((value) => value + 20)}
                  >
                    {tr("显示更多", "Show more")}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <History className="h-5 w-5" />
                {tr("军团报价记录", "Corporation quote history")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "显示最近 100 份报价，包含提交成员及当时的计价明细。报价记录不是合同已提交或已付款的证明。",
                  "Latest 100 quotes, including the member and original itemized prices. A quote does not prove that a contract was submitted or paid.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <BuybackQuoteHistory quotes={data.quotes} now={now} admin />
            </CardContent>
          </Card>
          {editor && (
            <RuleEditor
              initial={editor}
              version={data.settings.version}
              pending={pending || admin.isError}
              onSave={(id, input) => saveRule.mutate({ id, input })}
              onClose={() => setEditor(null)}
              tr={tr}
              zh={zh}
            />
          )}
          <AlertDialog
            open={deleting !== null}
            onOpenChange={(open) => {
              if (!open && !deleteRule.isPending) setDeleting(null);
            }}
          >
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {tr("移除此回收规则？", "Remove this override?")}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {tr("将移除", "Remove")} “
                  {deleting?.rule.targetName || deleting?.rule.targetId}”{" "}
                  {tr(
                    "的规则并恢复继承上级设置。这可能重新允许该物品回收，也可能改变价格；历史报价不会被删除。",
                    "and restore parent settings. This may allow the item again or change its price. Historical quotes will not be deleted.",
                  )}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={deleteRule.isPending}>
                  {tr("取消", "Cancel")}
                </AlertDialogCancel>
                <AlertDialogAction
                  disabled={pending || admin.isError}
                  onClick={(event) => {
                    event.preventDefault();
                    if (deleting) deleteRule.mutate(deleting);
                  }}
                >
                  {deleteRule.isPending
                    ? tr("正在移除…", "Removing…")
                    : tr("确认移除", "Remove override")}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}
    </div>
  );
}
