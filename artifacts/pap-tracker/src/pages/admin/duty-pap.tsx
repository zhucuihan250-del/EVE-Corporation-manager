import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  useGetMe,
  useSearchSolarSystemsForMonitoring,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Loader2,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  Search,
  Timer,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { fittingWorkbenchApi } from "@/lib/fitting-workbench-api";
import {
  formatPapDecimal,
  isPositivePapInput,
} from "@/lib/pap-currency-presentation";
import {
  DutyPapError,
  dutyPapApi,
  dutyPapKeys,
  dutyPapRuleInput,
  formatDutyUtc,
  dutyStatusLabel,
  isDutyFleetId,
  isDutyCapAtLeastAward,
  type DutyPapRule,
  type DutyPapInput,
} from "@/lib/duty-pap-api";

type Choice = { id: number; name: string };
type RuleDraft = {
  name: string;
  eveFleetId: string;
  currencyId: string;
  minutesPerAward: string;
  awardAmount: string;
  dailyCap: string;
  solarSystems: Choice[];
  shipTypes: Choice[];
  requireUndocked: boolean;
};
const emptyDraft = (): RuleDraft => ({
  name: "",
  eveFleetId: "",
  currencyId: "common",
  minutesPerAward: "60",
  awardAmount: "1",
  dailyCap: "2",
  solarSystems: [],
  shipTypes: [],
  requireUndocked: true,
});

export function AdminDutyPap() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const { data: user } = useGetMe();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const admin = useQuery({
    queryKey: [...dutyPapKeys.admin, user?.id, user?.corporationId],
    queryFn: ({ signal }) => dutyPapApi.admin(signal),
    enabled: Boolean(
      user?.id &&
      ["admin", "controller"].includes(user.role) &&
      user.modules.pap &&
      user.modules.fleet,
    ),
    refetchInterval: 60_000,
  });
  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<DutyPapRule | null>(null);
  const [form, setForm] = useState<RuleDraft>(emptyDraft);
  const [systemQuery, setSystemQuery] = useState("");
  const [shipQuery, setShipQuery] = useState("");
  const [debouncedSystemQuery, setDebouncedSystemQuery] = useState("");
  const [debouncedShipQuery, setDebouncedShipQuery] = useState("");
  const [toggleTarget, setToggleTarget] = useState<DutyPapRule | null>(null);
  const [uncertain, setUncertain] = useState(false);
  const creationRequest = useRef<{
    fingerprint: string;
    requestId: string;
  } | null>(null);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedSystemQuery(systemQuery.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [systemQuery]);
  useEffect(() => {
    const timer = window.setTimeout(
      () => setDebouncedShipQuery(shipQuery.trim()),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [shipQuery]);
  const systemSearch = useSearchSolarSystemsForMonitoring(
    { q: debouncedSystemQuery },
    {
      query: {
        enabled: editorOpen && debouncedSystemQuery.length >= 2,
        queryKey: ["dutyPap", "systemSearch", debouncedSystemQuery],
        staleTime: 3_600_000,
      },
    },
  );
  const shipSearch = useQuery({
    queryKey: ["dutyPap", "shipSearch", debouncedShipQuery, zh],
    queryFn: ({ signal }) =>
      fittingWorkbenchApi.catalog(
        {
          q: debouncedShipQuery,
          category: "ship",
          language: zh ? "zh" : "en",
          limit: 20,
        },
        signal,
      ),
    enabled: editorOpen && debouncedShipQuery.length >= 2,
    staleTime: 3_600_000,
  });
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: dutyPapKeys.all });
  const input = (): DutyPapInput => ({
    name: form.name.trim(),
    eveFleetId: form.eveFleetId.trim(),
    currencyId: form.currencyId === "common" ? null : Number(form.currencyId),
    minutesPerAward: Number(form.minutesPerAward),
    awardAmount: form.awardAmount,
    dailyCap: form.dailyCap,
    solarSystemIds: form.solarSystems.map((system) => system.id),
    shipTypeIds: form.shipTypes.map((ship) => ship.id),
    requireUndocked: form.requireUndocked,
    enabled: false,
  });
  const save = useMutation({
    mutationFn: async () => {
      const body = input();
      if (editing)
        return dutyPapApi.update(editing.id, {
          ...body,
          version: editing.version,
        });
      const fingerprint = JSON.stringify(body);
      if (creationRequest.current?.fingerprint !== fingerprint)
        creationRequest.current = {
          fingerprint,
          requestId: crypto.randomUUID(),
        };
      return dutyPapApi.create({
        ...body,
        requestId: creationRequest.current.requestId,
      });
    },
    onSuccess: async () => {
      setEditorOpen(false);
      setEditing(null);
      setUncertain(false);
      creationRequest.current = null;
      await refresh();
      toast({
        title: tr("规则已保存为停用状态", "Rule saved in disabled state"),
      });
    },
    onError: async (error) => {
      setUncertain(
        !(
          error instanceof DutyPapError &&
          error.status >= 400 &&
          error.status < 500
        ),
      );
      if (error instanceof DutyPapError && error.status === 409)
        await refresh();
    },
  });
  const toggle = useMutation({
    mutationFn: (rule: DutyPapRule) =>
      dutyPapApi.update(rule.id, {
        ...dutyPapRuleInput(rule),
        enabled: !rule.enabled,
        version: rule.version,
      }),
    onSuccess: async () => {
      setToggleTarget(null);
      await refresh();
      toast({ title: tr("规则状态已更新", "Rule status updated") });
    },
    onError: async () => {
      await refresh();
    },
  });
  const previewFleet = useMutation({
    mutationFn: dutyPapApi.myFleet,
    onSuccess: ({ fleetId }) => {
      setForm((current) => ({ ...current, eveFleetId: fleetId }));
      save.reset();
    },
  });
  const busy = save.isPending || toggle.isPending || previewFleet.isPending;
  const beginEdit = (rule: DutyPapRule | null) => {
    if (busy || uncertain) return;
    setEditing(rule);
    setForm(
      rule
        ? {
            name: rule.name,
            eveFleetId: rule.eveFleetId,
            currencyId:
              rule.currencyId === null ? "common" : String(rule.currencyId),
            minutesPerAward: String(rule.minutesPerAward),
            awardAmount: rule.awardAmount,
            dailyCap: rule.dailyCap,
            solarSystems: rule.solarSystemIds.map(
              (id) =>
                rule.solarSystems?.find((system) => system.id === id) ?? {
                  id,
                  name: tr(`星系 #${id}`, `System #${id}`),
                },
            ),
            shipTypes: rule.shipTypeIds.map(
              (id) =>
                rule.shipTypes?.find((ship) => ship.id === id) ?? {
                  id,
                  name: tr(`舰船 #${id}`, `Ship #${id}`),
                },
            ),
            requireUndocked: rule.requireUndocked,
          }
        : emptyDraft(),
    );
    setSystemQuery("");
    setShipQuery("");
    setDebouncedSystemQuery("");
    setDebouncedShipQuery("");
    save.reset();
    previewFleet.reset();
    creationRequest.current = null;
    setEditorOpen(true);
    window.setTimeout(
      () =>
        document
          .getElementById("duty-rule-editor")
          ?.scrollIntoView({ behavior: "smooth", block: "start" }),
      0,
    );
  };
  const change = (patch: Partial<RuleDraft>) => {
    if (!busy && !uncertain) {
      setForm((current) => ({ ...current, ...patch }));
      save.reset();
    }
  };
  const currencyUsable =
    form.currencyId === "common" ||
    Boolean(
      admin.data?.currencies.some(
        (currency) => String(currency.id) === form.currencyId,
      ),
    );
  const valid =
    form.name.trim().length >= 1 &&
    form.name.trim().length <= 80 &&
    !/[\u0000-\u001f\u007f]/.test(form.name) &&
    isDutyFleetId(form.eveFleetId.trim()) &&
    /^\d{1,4}$/.test(form.minutesPerAward) &&
    Number(form.minutesPerAward) >= 1 &&
    Number(form.minutesPerAward) <= 1440 &&
    isPositivePapInput(form.awardAmount, 1_000_000n) &&
    isPositivePapInput(form.dailyCap, 1_000_000n) &&
    isDutyCapAtLeastAward(form.dailyCap, form.awardAmount) &&
    currencyUsable &&
    form.solarSystems.length <= 50 &&
    form.shipTypes.length <= 100;
  const toggleVersionCurrent = Boolean(
    toggleTarget &&
    admin.data?.rules.some(
      (rule) =>
        rule.id === toggleTarget.id && rule.version === toggleTarget.version,
    ),
  );
  useEffect(() => {
    setEditorOpen(false);
    setEditing(null);
    setForm(emptyDraft());
    setToggleTarget(null);
    setUncertain(false);
    creationRequest.current = null;
  }, [user?.id, user?.corporationId]);
  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Timer className="h-6 w-6 text-primary" />
            {tr("自动值守 PAP", "Automatic duty PAP")}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {tr(
              "由管理员认可游戏舰队并设置有效时长、PAP 种类与每日发放上限；不要求统帅是本军团 FC。",
              "Recognize an in-game fleet and configure verified time, PAP currency and daily award limits. The fleet commander does not need to be a corporation FC.",
            )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={busy || admin.isFetching}
            onClick={() => void refresh()}
          >
            <RefreshCw
              className={`mr-2 h-4 w-4 ${admin.isFetching ? "animate-spin" : ""}`}
            />
            {tr("刷新", "Refresh")}
          </Button>
          <Button
            disabled={busy || uncertain || !admin.data}
            onClick={() => beginEdit(null)}
          >
            <Plus className="mr-2 h-4 w-4" />
            {tr("创建规则", "Create rule")}
          </Button>
        </div>
      </div>
      {admin.isLoading && (
        <div className="flex justify-center py-12">
          <Loader2 className="h-7 w-7 animate-spin text-primary" />
        </div>
      )}
      {(admin.error || toggle.error) && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm"
        >
          {getErrorMessage(toggle.error ?? admin.error)}
        </div>
      )}
      {editorOpen && (
        <Card id="duty-rule-editor" className="border-primary/40">
          <CardHeader>
            <CardTitle className="text-lg">
              {editing
                ? tr("编辑值守规则", "Edit duty rule")
                : tr("创建值守规则", "Create duty rule")}
            </CardTitle>
            <CardDescription>
              {tr(
                "保存后规则为停用状态，需要另行确认开启。修改或启停会清除未结算余时，已发金额仍计入当日上限。",
                "Saving leaves the rule disabled until separately confirmed. Editing or changing status clears incomplete time; awarded amounts still count toward today's limit.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="duty-rule-name">
                  {tr("规则名称", "Rule name")}
                </Label>
                <Input
                  id="duty-rule-name"
                  value={form.name}
                  maxLength={80}
                  disabled={busy || uncertain}
                  onChange={(event) => change({ name: event.target.value })}
                  placeholder={tr("例如：值守舰队", "e.g. Standing fleet")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="duty-rule-fleet">
                  {tr("游戏舰队编号", "In-game fleet ID")}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="duty-rule-fleet"
                    value={form.eveFleetId}
                    maxLength={16}
                    inputMode="numeric"
                    disabled={busy || uncertain}
                    onChange={(event) =>
                      change({ eveFleetId: event.target.value })
                    }
                    placeholder={tr(
                      "填写明确的游戏舰队编号",
                      "Enter an explicit fleet ID",
                    )}
                  />
                  <Button
                    variant="outline"
                    className="shrink-0"
                    disabled={busy || uncertain}
                    onClick={() => previewFleet.mutate()}
                  >
                    {previewFleet.isPending ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Search className="h-4 w-4" />
                    )}
                    <span className="ml-2 hidden sm:inline">
                      {tr("读取我的舰队", "Read my fleet")}
                    </span>
                    <span className="sr-only sm:hidden">
                      {tr("读取我的舰队", "Read my fleet")}
                    </span>
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "读取的是当前登录角色所在舰队，不要求你是统帅。游戏内舰队重建后编号会改变。",
                    "Reads the current login character's fleet; you need not be commander. Recreated fleets have a new ID.",
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="duty-rule-currency">
                  {tr("发放 PAP 种类", "Award currency")}
                </Label>
                <Select
                  value={form.currencyId}
                  onValueChange={(currencyId) => change({ currencyId })}
                  disabled={busy || uncertain}
                >
                  <SelectTrigger id="duty-rule-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="common">
                      {tr("通用 PAP", "Common PAP")}
                    </SelectItem>
                    {admin.data?.currencies.map((currency) => (
                      <SelectItem key={currency.id} value={String(currency.id)}>
                        {currency.name}
                        {!currency.issuanceEnabled
                          ? tr("（已暂停发放）", " (issuance paused)")
                          : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "只使用已有 PAP 种类，不会自动创建新种类。",
                    "Only existing PAP currencies are used; none are created automatically.",
                  )}{" "}
                  {tr(
                    "已有发放记录的规则不可更换 PAP 种类；请停用旧规则并新建。",
                    "A rule with award history cannot change currency; disable it and create a new rule.",
                  )}{" "}
                  {tr(
                    "选择已暂停发放的种类可保存为停用规则；开启前需先恢复该种类发放。",
                    "A paused currency can be saved in a disabled rule; restore its issuance before enabling the rule.",
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="duty-rule-minutes">
                  {tr("每轮有效时长（分钟）", "Verified minutes per interval")}
                </Label>
                <Input
                  id="duty-rule-minutes"
                  value={form.minutesPerAward}
                  inputMode="numeric"
                  maxLength={4}
                  disabled={busy || uncertain}
                  onChange={(event) =>
                    change({ minutesPerAward: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  1–1440{" "}
                  {tr(
                    "分钟；只有连续有效观测间隔会累计。",
                    "minutes; only intervals between valid observations accrue.",
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="duty-rule-amount">
                  {tr("每轮发放数量", "PAP per interval")}
                </Label>
                <Input
                  id="duty-rule-amount"
                  value={form.awardAmount}
                  inputMode="decimal"
                  maxLength={20}
                  disabled={busy || uncertain}
                  onChange={(event) =>
                    change({ awardAmount: event.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "大于 0，最多 1,000,000，最多 6 位小数。",
                    "Greater than 0, at most 1,000,000, up to 6 decimal places.",
                  )}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="duty-rule-cap">
                  {tr("每日 PAP 金额上限", "Daily PAP amount limit")}
                </Label>
                <Input
                  id="duty-rule-cap"
                  value={form.dailyCap}
                  inputMode="decimal"
                  maxLength={20}
                  disabled={busy || uncertain}
                  onChange={(event) => change({ dailyCap: event.target.value })}
                />
                <p className="text-xs text-muted-foreground">
                  {tr(
                    "不得小于单轮数量；按 UTC 日统计，最后一笔可按剩余额度部分发放。",
                    "Cannot be below one interval's award. Uses UTC days; the final award may be partial.",
                  )}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-md border p-3">
              <Switch
                id="duty-rule-undocked"
                checked={form.requireUndocked}
                onCheckedChange={(requireUndocked) =>
                  change({ requireUndocked })
                }
                disabled={busy || uncertain}
              />
              <div>
                <Label htmlFor="duty-rule-undocked">
                  {tr("必须未停靠", "Must be undocked")}
                </Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  {tr(
                    "始终要求角色在线。启用此项时，空间站与建筑内停靠的时间都不计入。",
                    "The character must always be online. When enabled, docking in stations or structures does not count.",
                  )}
                </p>
              </div>
            </div>
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-3">
                <Label htmlFor="duty-system-search">
                  {tr(
                    "允许星系（留空为不限）",
                    "Allowed systems (empty = unrestricted)",
                  )}
                </Label>
                <Input
                  id="duty-system-search"
                  value={systemQuery}
                  disabled={busy || uncertain || form.solarSystems.length >= 50}
                  maxLength={80}
                  onChange={(event) => setSystemQuery(event.target.value)}
                  placeholder={tr(
                    "输入部分名称，例如 74L",
                    "Enter part of a name, e.g. 74L",
                  )}
                />
                {systemQuery.trim().length >= 2 &&
                  systemQuery.trim() === debouncedSystemQuery && (
                    <div
                      className="max-h-48 overflow-y-auto rounded-md border"
                      aria-label={tr("星系搜索结果", "System search results")}
                    >
                      {systemSearch.isFetching ? (
                        <p className="p-3 text-sm text-muted-foreground">
                          {tr("正在搜索…", "Searching…")}
                        </p>
                      ) : systemSearch.error ? (
                        <p
                          role="alert"
                          className="p-3 text-sm text-destructive"
                        >
                          {getErrorMessage(systemSearch.error)}
                        </p>
                      ) : !systemSearch.data?.length ? (
                        <p className="p-3 text-sm text-muted-foreground">
                          {tr("没有匹配的星系", "No matching systems")}
                        </p>
                      ) : (
                        systemSearch.data.map((system) => (
                          <button
                            type="button"
                            key={system.solarSystemId}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-40"
                            disabled={
                              busy ||
                              uncertain ||
                              form.solarSystems.some(
                                (item) => item.id === system.solarSystemId,
                              ) ||
                              form.solarSystems.length >= 50
                            }
                            onClick={() => {
                              change({
                                solarSystems: [
                                  ...form.solarSystems,
                                  {
                                    id: system.solarSystemId,
                                    name: system.solarSystemName,
                                  },
                                ],
                              });
                              setSystemQuery("");
                            }}
                          >
                            {system.solarSystemName}
                          </button>
                        ))
                      )}
                    </div>
                  )}
                <div className="flex flex-wrap gap-2">
                  {form.solarSystems.map((system) => (
                    <Badge
                      key={system.id}
                      variant="secondary"
                      className="max-w-full gap-1 py-1"
                    >
                      <span className="truncate">{system.name}</span>
                      <button
                        type="button"
                        disabled={busy || uncertain}
                        aria-label={`${tr("移除星系", "Remove system")} ${system.name}`}
                        onClick={() =>
                          change({
                            solarSystems: form.solarSystems.filter(
                              (item) => item.id !== system.id,
                            ),
                          })
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {form.solarSystems.length}/50 ·{" "}
                  {tr(
                    "从搜索结果中选择，不需要填写编号。",
                    "Select from search results; no IDs needed.",
                  )}
                </p>
              </div>
              <div className="space-y-3">
                <Label htmlFor="duty-ship-search">
                  {tr(
                    "允许舰船型号（留空为不限）",
                    "Allowed hulls (empty = unrestricted)",
                  )}
                </Label>
                <Input
                  id="duty-ship-search"
                  value={shipQuery}
                  disabled={busy || uncertain || form.shipTypes.length >= 100}
                  maxLength={100}
                  onChange={(event) => setShipQuery(event.target.value)}
                  placeholder={tr(
                    "输入舰船中文或英文名称",
                    "Enter a Chinese or English hull name",
                  )}
                />
                {shipQuery.trim().length >= 2 &&
                  shipQuery.trim() === debouncedShipQuery && (
                    <div
                      className="max-h-48 overflow-y-auto rounded-md border"
                      aria-label={tr("舰船搜索结果", "Ship search results")}
                    >
                      {shipSearch.isFetching ? (
                        <p className="p-3 text-sm text-muted-foreground">
                          {tr("正在搜索…", "Searching…")}
                        </p>
                      ) : shipSearch.error ? (
                        <p
                          role="alert"
                          className="p-3 text-sm text-destructive"
                        >
                          {getErrorMessage(shipSearch.error)}
                        </p>
                      ) : !shipSearch.data?.items.length ? (
                        <p className="p-3 text-sm text-muted-foreground">
                          {tr("没有匹配的舰船", "No matching hulls")}
                        </p>
                      ) : (
                        shipSearch.data.items.map((ship) => (
                          <button
                            type="button"
                            key={ship.typeId}
                            className="block w-full px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-40"
                            disabled={
                              busy ||
                              uncertain ||
                              form.shipTypes.some(
                                (item) => item.id === ship.typeId,
                              ) ||
                              form.shipTypes.length >= 100
                            }
                            onClick={() => {
                              change({
                                shipTypes: [
                                  ...form.shipTypes,
                                  { id: ship.typeId, name: ship.name },
                                ],
                              });
                              setShipQuery("");
                            }}
                          >
                            {ship.name}
                            <span className="ml-2 text-xs text-muted-foreground">
                              {ship.groupName}
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                <div className="flex flex-wrap gap-2">
                  {form.shipTypes.map((ship) => (
                    <Badge
                      key={ship.id}
                      variant="secondary"
                      className="max-w-full gap-1 py-1"
                    >
                      <span className="truncate">{ship.name}</span>
                      <button
                        type="button"
                        disabled={busy || uncertain}
                        aria-label={`${tr("移除舰船", "Remove hull")} ${ship.name}`}
                        onClick={() =>
                          change({
                            shipTypes: form.shipTypes.filter(
                              (item) => item.id !== ship.id,
                            ),
                          })
                        }
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {form.shipTypes.length}/100 ·{" "}
                  {tr(
                    "按明确船体筛选，空白不限制型号。",
                    "Filter by explicit hull; empty allows any hull.",
                  )}
                </p>
              </div>
            </div>
            {(save.error || previewFleet.error) && (
              <p
                role="alert"
                className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm"
              >
                {getErrorMessage(save.error ?? previewFleet.error)}
              </p>
            )}
            {uncertain && (
              <p role="alert" className="text-sm text-amber-400">
                {tr(
                  "保存结果未确认。可刷新列表核对，或使用原请求重试；请勿另建重复规则。",
                  "The save result is uncertain. Refresh to check or retry the same request; do not create a duplicate rule.",
                )}
              </p>
            )}
            {!valid && (
              <p className="text-xs text-muted-foreground">
                {tr(
                  "请核对名称、舰队编号、时间、有效 PAP 种类与数量；每日上限需不小于单轮发放。",
                  "Check the name, fleet ID, time, eligible currency and amounts. The daily limit must be at least one award.",
                )}
              </p>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                disabled={busy || uncertain}
                onClick={() => {
                  setEditorOpen(false);
                  setEditing(null);
                }}
              >
                {tr("取消", "Cancel")}
              </Button>
              <Button disabled={!valid || busy} onClick={() => save.mutate()}>
                {save.isPending && (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                )}
                {uncertain
                  ? tr("重试原保存请求", "Retry original save")
                  : tr("保存为停用规则", "Save disabled rule")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
      {admin.data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tr("值守规则", "Duty rules")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "每个游戏舰队只可启用一个发放规则。暂停、修改或重建舰队后不会自动补发历史时间。",
                  "Only one award rule per in-game fleet may be enabled. Pausing, editing or recreating a fleet does not backfill past time.",
                )}{" "}
                {tr(
                  "窄屏可左右滑动表格查看全部信息与操作。",
                  "Swipe tables horizontally on narrow screens to view all details and actions.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {!admin.data.rules.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {tr(
                    "尚无规则。请创建并确认条件后单独开启。",
                    "No rules yet. Create one, confirm its conditions, then enable it separately.",
                  )}
                </p>
              ) : (
                <Table className="min-w-[680px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tr("规则／舰队", "Rule / fleet")}</TableHead>
                      <TableHead>
                        {tr("发放条件", "Award conditions")}
                      </TableHead>
                      <TableHead>{tr("状态", "Status")}</TableHead>
                      <TableHead className="text-right">
                        {tr("操作", "Actions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {admin.data.rules.map((rule) => (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <div className="font-medium">{rule.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {rule.eveFleetId}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="text-sm">
                            {rule.minutesPerAward} {tr("分钟", "min")} →{" "}
                            {formatPapDecimal(rule.awardAmount)}{" "}
                            {rule.currencyName}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {tr("每日上限", "Daily limit")}:{" "}
                            {formatPapDecimal(rule.dailyCap)} ·{" "}
                            {rule.requireUndocked
                              ? tr("未停靠", "Undocked")
                              : tr("允许停靠", "Docking allowed")}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {tr("星系", "Systems")}:{" "}
                            {rule.solarSystemIds.length || tr("不限", "Any")} ·{" "}
                            {tr("舰种", "Hulls")}:{" "}
                            {rule.shipTypeIds.length || tr("不限", "Any")}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={rule.enabled ? "default" : "secondary"}
                          >
                            {rule.enabled
                              ? tr("已启用", "Enabled")
                              : tr("已停用", "Disabled")}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={busy || uncertain}
                              onClick={() => beginEdit(rule)}
                            >
                              <Pencil className="mr-1 h-3.5 w-3.5" />
                              {tr("编辑", "Edit")}
                            </Button>
                            <Button
                              variant={rule.enabled ? "outline" : "default"}
                              size="sm"
                              disabled={busy || uncertain}
                              onClick={() => {
                                toggle.reset();
                                setToggleTarget(rule);
                              }}
                            >
                              <Power className="mr-1 h-3.5 w-3.5" />
                              {rule.enabled
                                ? tr("停用", "Disable")
                                : tr("开启", "Enable")}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tr("成员采集状态", "Member collection status")}
              </CardTitle>
              <CardDescription>
                {tr(
                  "仅展示本军团已授权的采集状态，不展示授权令牌或成员具体位置。",
                  "Shows this corporation's collection status only, without tokens or exact member locations.",
                )}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {!admin.data.connections.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {tr(
                    "暂无成员授权值守采集",
                    "No members have authorized duty collection",
                  )}
                </p>
              ) : (
                <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        {tr("成员／角色", "Member / character")}
                      </TableHead>
                      <TableHead>{tr("状态", "Status")}</TableHead>
                      <TableHead>{tr("最后检查", "Last check")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {admin.data.connections.map((connection) => (
                      <TableRow key={connection.userId}>
                        <TableCell>
                          <div className="font-medium">
                            {connection.userName}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {connection.characterName}
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge
                            variant={
                              connection.enabled ? "default" : "secondary"
                            }
                            className="whitespace-normal"
                          >
                            {dutyStatusLabel(
                              connection.enabled ? connection.status : "paused",
                              zh,
                            )}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDutyUtc(connection.lastCheckedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {tr("最近自动入账记录", "Recent automatic credits")}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {!admin.data.awards.length ? (
                <p className="p-6 text-center text-sm text-muted-foreground">
                  {tr("暂无自动发放记录", "No automatic awards yet")}
                </p>
              ) : (
                <Table className="min-w-[520px]">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{tr("时间", "Time")}</TableHead>
                      <TableHead>{tr("成员／规则", "Member / rule")}</TableHead>
                      <TableHead className="text-right">
                        {tr("已入账", "Credited")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {admin.data.awards.map((award) => (
                      <TableRow key={award.id}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {formatDutyUtc(award.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">
                            {award.userName} · {award.characterName}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {award.ruleName}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="font-medium text-primary">
                            +{formatPapDecimal(award.amount)}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {award.currencyName}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {tr("安全边界", "Safety boundaries")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            {tr(
              "新规则默认停用。开启前请确认舰队编号和发放条件；开启后会按规则自动入账。舰队重建后必须重新认可新的编号。",
              "New rules are disabled by default. Confirm the fleet ID and conditions before enabling automatic credits. A recreated fleet must have its new ID recognized explicitly.",
            )}
          </p>
          <p>
            {tr(
              "每个账号仅跟踪一个自愿授权的角色。UTC 每日 00:00 重置未完成进度；接口异常不计时、不回补，不等同于人工确认认真值守。",
              "Each account tracks only one opted-in character. Incomplete progress resets at 00:00 UTC. API failures are not counted or backfilled, and collection is not proof of attentive participation.",
            )}
          </p>
        </CardContent>
      </Card>
      <AlertDialog
        open={Boolean(toggleTarget)}
        onOpenChange={(open) => {
          if (!open && !toggle.isPending) setToggleTarget(null);
        }}
      >
        <AlertDialogContent
          style={{
            width: "calc(100vw - 2rem)",
            maxWidth: 512,
            maxHeight: "calc(100dvh - 2rem)",
            overflowY: "auto",
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-400" />
              {toggleTarget?.enabled
                ? tr("停用值守规则？", "Disable duty rule?")
                : tr("确认开启自动入账？", "Enable automatic credits?")}
            </AlertDialogTitle>
            <AlertDialogDescription className="space-y-2">
              <span className="block">
                {toggleTarget?.name} · {tr("舰队", "Fleet")}{" "}
                {toggleTarget?.eveFleetId}
              </span>
              <span className="block">
                {toggleTarget?.enabled
                  ? tr(
                      "停用后该规则立即停止计时并清除未结算余时；已发 PAP 不变。",
                      "Disabling stops accrual and clears incomplete time; existing PAP awards remain.",
                    )
                  : tr(
                      "开启后会自动核验已授权成员，并在达到时间条件后向他们发放 PAP。请确认舰队编号和金额，不要求本军团 FC。",
                      "Enabling automatically verifies opted-in members and credits PAP after they complete the time requirement. Confirm the fleet ID and amount; a corporation FC is not required.",
                    )}
              </span>
              {toggleTarget && (
                <span className="block">
                  {toggleTarget.minutesPerAward} {tr("分钟", "min")} →{" "}
                  {formatPapDecimal(toggleTarget.awardAmount)}{" "}
                  {toggleTarget.currencyName} · {tr("每日上限", "daily limit")}{" "}
                  {formatPapDecimal(toggleTarget.dailyCap)}
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {toggle.error && (
            <p role="alert" className="text-sm text-destructive">
              {getErrorMessage(toggle.error)}
            </p>
          )}
          {toggleTarget && !toggleVersionCurrent && (
            <p role="alert" className="text-sm text-amber-400">
              {tr(
                "该规则已经更新，请取消后刷新并重新确认。",
                "This rule has changed. Cancel, refresh and confirm again.",
              )}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={toggle.isPending}>
              {tr("取消", "Cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={toggle.isPending || !toggleVersionCurrent}
              onClick={(event) => {
                event.preventDefault();
                if (toggleTarget && toggleVersionCurrent)
                  toggle.mutate(toggleTarget);
              }}
            >
              {toggle.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {toggleTarget?.enabled
                ? tr("确认停用", "Confirm disable")
                : tr("确认开启自动入账", "Confirm automatic credits")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
