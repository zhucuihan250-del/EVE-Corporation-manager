import {
  useListFleets, useCreateFleet, useUpdateFleet, useScanFleetMembers,
  useGetMe, useListIdentityGroups,
  getListFleetsQueryKey, getGetRecentFleetsQueryKey, getGetAdminSummaryQueryKey,
  getGetDashboardSummaryQueryKey, getListUsersQueryKey, getListAllPapRecordsQueryKey,
  type Fleet,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Loader2, Swords, Plus, Shield, ScanSearch, Crosshair, Radio, Settings2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { useLiveFleetCounts } from "@/hooks/use-live-fleet-counts";
import { apiUrl } from "@/lib/api";
import { papCurrencyApi, papCurrencyKeys } from "@/lib/pap-currency-api";
import { isPositivePapInput } from "@/lib/pap-currency-presentation";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";

async function fetchEsiFleetId(): Promise<{ fleetId: string; role: string }> {
  const resp = await fetch(apiUrl("/api/fleets/esi-my-fleet"), { credentials: "include" });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "ESI error");
  return data;
}

export function AdminFleets() {
  const { t, i18n } = useTranslation();
  const tr = (cn: string, en: string) => i18n.language.startsWith("zh") ? cn : en;
  const { data: fleets, isLoading } = useListFleets();
  const { data: currentUser } = useGetMe();
  const currencies = useQuery({ queryKey: papCurrencyKeys.currencies, queryFn: ({ signal }) => papCurrencyApi.currencies(signal) });
  const identityGroups = useListIdentityGroups(undefined, {
    query: { enabled: Boolean(currentUser?.modules.identity), queryKey: ["/api/identity-groups"] },
  });
  const createFleet = useCreateFleet();
  const updateFleet = useUpdateFleet();
  const scanFleet = useScanFleetMembers();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [fleetName, setFleetName] = useState("");
  const [fleetCommander, setFleetCommander] = useState("");
  const [papValue, setPapValue] = useState("");
  const [papCurrencyId, setPapCurrencyId] = useState("");
  const [eveFleetId, setEveFleetId] = useState("");
  const [fleetFunction, setFleetFunction] = useState("general");
  const [identityGroupId, setIdentityGroupId] = useState("");
  const [scanningId, setScanningId] = useState<number | null>(null);
  const [fetchingCreateId, setFetchingCreateId] = useState(false);
  const [updatingFleetId, setUpdatingFleetId] = useState<number | null>(null);
  const [standingDownId, setStandingDownId] = useState<number | null>(null);
  const [configuringFleet, setConfiguringFleet] = useState<Fleet | null>(null);
  const [configFunction, setConfigFunction] = useState("");
  const [configIdentityGroupId, setConfigIdentityGroupId] = useState("");
  const [configPapCurrencyId, setConfigPapCurrencyId] = useState("");
  const [configPapValue, setConfigPapValue] = useState("");
  const fleetList = Array.isArray(fleets) ? fleets : [];
  const tacticalGroups = (identityGroups.data ?? []).filter((group) => group.category === "combat" && group.isActive);
  const availableCurrencies = (currencies.data?.currencies ?? []).filter((currency) => currency.issuanceEnabled);
  const validPapAmount = (value: string) => isPositivePapInput(value) && Number(value) <= 1_000_000;

  const { liveCounts, scanFleet: scanFleetLive } = useLiveFleetCounts(fleetList);

  const invalidateAfterScan = () => {
    queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRecentFleetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdminSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAllPapRecordsQueryKey() });
    queryClient.invalidateQueries({ queryKey: papCurrencyKeys.all });
  };


  const activeScannableFleets = fleetList.filter(f => f.isActive && f.eveFleetId);

  const handleFetchFleetIdForCreate = async () => {
    setFetchingCreateId(true);
    try {
      const data = await fetchEsiFleetId();
      setEveFleetId(data.fleetId);
      toast({ title: t("fleets.fleetIdFetched"), description: t("fleets.fleetIdFetchedDesc") });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("fleets.scanFailedDesc");
      const isNotInFleet = msg.includes("not currently in a fleet");
      toast({
        title: isNotInFleet ? t("fleets.notInFleet") : t("fleets.scanFailed"),
        description: isNotInFleet ? t("fleets.notInFleetDesc") : msg,
        variant: "destructive",
      });
    } finally {
      setFetchingCreateId(false);
    }
  };

  const handleUpdateFleetIdFromEsi = async (fleet: { id: number }) => {
    setUpdatingFleetId(fleet.id);
    try {
      const data = await fetchEsiFleetId();

      await new Promise<void>((resolve, reject) => {
        updateFleet.mutate(
          { id: fleet.id, data: { eveFleetId: data.fleetId } },
          { onSuccess: () => resolve(), onError: reject },
        );
      });

      setScanningId(fleet.id);
      setUpdatingFleetId(null);
      try {
        const count = await scanFleetLive(fleet.id);
        toast({ title: t("fleets.scanComplete"), description: t("fleets.scanCountDesc", { count }) });
      } catch {
        toast({ title: t("fleets.scanFailed"), description: t("fleets.scanFailedDesc"), variant: "destructive" });
      } finally {
        setScanningId(null);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : t("fleets.scanFailedDesc");
      const isNotInFleet = msg.includes("not currently in a fleet");
      toast({
        title: isNotInFleet ? t("fleets.notInFleet") : t("fleets.scanFailed"),
        description: isNotInFleet ? t("fleets.notInFleetDesc") : msg,
        variant: "destructive",
      });
      setUpdatingFleetId(null);
    }
  };

  const handleCreateFleet = () => {
    if (!fleetName || !fleetCommander || !validPapAmount(papValue)) return;
    createFleet.mutate(
      { data: {
        name: fleetName,
        fleetCommander,
        papValue: Number(papValue),
        papCurrencyId: papCurrencyId ? Number(papCurrencyId) : null,
        eveFleetId: eveFleetId || null,
        fleetFunction: fleetFunction.trim() || "general",
        identityGroupId: identityGroupId ? Number(identityGroupId) : null,
      } },
      {
        onSuccess: () => {
          toast({ title: t("fleets.fleetCreated"), description: t("fleets.newOperationRegistered") });
          invalidateAfterScan();
          setCreateModalOpen(false);
          setFleetName("");
          setFleetCommander("");
          setPapValue("");
          setPapCurrencyId("");
          setEveFleetId("");
          setFleetFunction("general");
          setIdentityGroupId("");
        },
        onError: (error) => toast({ title: tr("创建失败", "Could not create fleet"), description: error.message, variant: "destructive" }),
      }
    );
  };

  const handleEndFleet = async (fleet: { id: number; eveFleetId?: string | null }) => {
    setStandingDownId(fleet.id);

    if (fleet.eveFleetId) {
      await new Promise<void>((resolve) => {
        scanFleet.mutate(
          { id: fleet.id },
          {
            onSuccess: (data) => {
              const scanData = data as typeof data & { esiMemberCount?: number; autoRegistered?: number };
              if (data.awarded > 0) {
                toast({
                  title: t("fleets.scanComplete"),
                  description: t("fleets.scanCompleteDesc", {
                    esiMemberCount: scanData.esiMemberCount ?? 0,
                    awarded: data.awarded,
                    skipped: data.skipped,
                    notFound: data.notFound,
                    autoRegistered: scanData.autoRegistered ?? 0,
                  }),
                });
              }
              resolve();
            },
            onError: (error) => {
              toast({ title: tr("本次 PAP 发放未完成", "PAP awards did not complete"), description: error.message, variant: "destructive" });
              resolve();
            },
          },
        );
      });
    }

    updateFleet.mutate(
      { id: fleet.id, data: { isActive: false, endedAt: new Date().toISOString() } },
      {
        onSuccess: () => {
          toast({ title: t("fleets.fleetEnded"), description: t("fleets.operationComplete") });
          invalidateAfterScan();
        },
        onSettled: () => setStandingDownId(null),
      }
    );
  };

  const handleScanFleet = async (fleetId: number, hasEveId: boolean) => {
    if (!hasEveId) {
      toast({ title: t("fleets.scanFailed"), description: t("fleets.noEveFleetId"), variant: "destructive" });
      return;
    }
    setScanningId(fleetId);
    try {
      const count = await scanFleetLive(fleetId);
      toast({ title: t("fleets.scanComplete"), description: t("fleets.scanCountDesc", { count }) });
    } catch {
      toast({ title: t("fleets.scanFailed"), description: t("fleets.scanFailedDesc"), variant: "destructive" });
    } finally {
      setScanningId(null);
    }
  };

  const openFleetConfiguration = (fleet: Fleet) => {
    setConfiguringFleet(fleet);
    setConfigFunction(fleet.fleetFunction);
    setConfigIdentityGroupId(fleet.identityGroupId ? String(fleet.identityGroupId) : "");
    setConfigPapCurrencyId(fleet.papCurrencyId ? String(fleet.papCurrencyId) : "");
    setConfigPapValue(String(fleet.papValue));
  };

  const saveFleetConfiguration = () => {
    if (!configuringFleet || !configFunction.trim()) return;
    const amountChanged = configPapValue !== String(configuringFleet.papValue);
    if (amountChanged && !validPapAmount(configPapValue)) return;
    updateFleet.mutate({ id: configuringFleet.id, data: {
      fleetFunction: configFunction.trim(),
      identityGroupId: configIdentityGroupId ? Number(configIdentityGroupId) : null,
      papCurrencyId: configPapCurrencyId ? Number(configPapCurrencyId) : null,
      ...(amountChanged ? { papValue: Number(configPapValue) } : {}),
    } }, { onSuccess: () => {
      setConfiguringFleet(null);
      queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
      toast({ title: tr("舰队设置已更新", "Fleet settings updated") });
    }, onError: (error) => toast({ title: tr("保存失败", "Could not save fleet"), description: error.message, variant: "destructive" }) });
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("fleets.title")}</h1>
          <p className="text-muted-foreground font-mono text-sm">{t("fleets.subtitle")}</p>
        </div>
        <Button onClick={() => setCreateModalOpen(true)} className="font-mono rounded-sm text-xs tracking-wider">
          <Plus className="w-4 h-4 mr-2" /> {t("fleets.newOperation")}
        </Button>
      </div>

      {activeScannableFleets.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 bg-primary/5 border border-primary/20 rounded-sm">
          <Radio className="w-3 h-3 text-primary animate-pulse" />
          <span className="font-mono text-[11px] text-primary tracking-wider">
            {t("fleets.autoScanActive", { count: activeScannableFleets.length })}
          </span>
        </div>
      )}

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">{t("fleets.combatRegistry")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !fleetList.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              {t("fleets.noFleets")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("fleets.operation")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("fleets.commander")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("fleets.status")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("fleets.value")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("fleets.pilots")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("fleets.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fleetList.map((fleet) => (
                  <TableRow key={fleet.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-foreground">
                      <div className="flex flex-col">
                        <span>{fleet.name}</span>
                        <span className="text-[10px] text-primary/80 mt-0.5">{tr("职能", "Function")}: {fleet.fleetFunction}</span>
                        {fleet.identityGroupName && <Badge variant="outline" className="mt-1 w-fit border-violet-500/40 text-violet-300">{fleet.identityGroupName}</Badge>}
                        <span className="text-xs text-muted-foreground">{format(new Date(fleet.createdAt), "MMM dd, HH:mm")}</span>
                        {fleet.eveFleetId ? (
                          <span className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">ID: {fleet.eveFleetId}</span>
                        ) : (
                          <span className="text-[10px] text-amber-500/70 font-mono mt-0.5">NO FLEET ID</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      <div className="flex items-center gap-2 mt-2">
                        <Shield className="w-3 h-3 text-primary" /> {fleet.fleetCommander}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={fleet.isActive ? 'default' : 'secondary'} className="font-mono text-[10px] rounded-sm">
                        {fleet.isActive ? t("fleets.active") : t("fleets.concluded")}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono font-bold text-right text-primary">
                      {fleet.papValue}
                      <div className="mt-1 text-xs font-normal text-muted-foreground">{fleet.papCurrencyId ? fleet.papCurrencyName : tr("通用 PAP", "Common PAP")}</div>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-right text-muted-foreground">
                      {fleet.isActive
                        ? (liveCounts[fleet.id] ?? <span className="text-muted-foreground/40">—</span>)
                        : (fleet.participantCount || 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button variant="outline" size="sm" className="h-8 mb-2 ml-2 rounded-sm font-mono text-[10px]" onClick={() => openFleetConfiguration(fleet)}>
                        <Settings2 className="w-3 h-3 mr-1" />{tr("设置", "SETTINGS")}
                      </Button>
                      {fleet.isActive ? (
                        <div className="flex items-center justify-end gap-2 flex-wrap">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-sm font-mono text-[10px] border-amber-500/30 text-amber-400 hover:bg-amber-500/10"
                            onClick={() => handleUpdateFleetIdFromEsi(fleet)}
                            disabled={updatingFleetId === fleet.id || standingDownId === fleet.id}
                          >
                            {updatingFleetId === fleet.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Crosshair className="w-3 h-3 mr-1" />
                            )}
                            {updatingFleetId === fleet.id ? t("fleets.updatingFleetId") : t("fleets.updateFleetId")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-sm font-mono text-[10px] border-primary/30 text-primary hover:bg-primary/10"
                            onClick={() => handleScanFleet(fleet.id, !!fleet.eveFleetId)}
                            disabled={scanningId === fleet.id || standingDownId === fleet.id}
                          >
                            {scanningId === fleet.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <ScanSearch className="w-3 h-3 mr-1" />
                            )}
                            {scanningId === fleet.id ? t("fleets.scanning") : t("fleets.scanEsi")}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            className="h-8 rounded-sm font-mono text-[10px]"
                            onClick={() => handleEndFleet(fleet)}
                            disabled={standingDownId === fleet.id || updateFleet.isPending}
                          >
                            {standingDownId === fleet.id ? (
                              <Loader2 className="w-3 h-3 animate-spin mr-1" />
                            ) : null}
                            {standingDownId === fleet.id ? t("fleets.standingDown") : t("fleets.standDown")}
                          </Button>
                        </div>
                      ) : fleet.battleReportId ? (
                        <Link href={`/battle-reports/${fleet.battleReportId}`}>
                          <Button variant="outline" size="sm" className="h-8 rounded-sm font-mono text-[10px] border-primary/30 text-primary hover:bg-primary/10">
                            <Crosshair className="w-3 h-3 mr-1" />
                            {t("fleets.viewBattleReport")}
                          </Button>
                        </Link>
                      ) : (
                        <span className="font-mono text-[10px] text-muted-foreground">{t("fleets.reportPending")}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={createModalOpen} onOpenChange={setCreateModalOpen}>
        <DialogContent className="sm:max-w-[425px] max-h-[90vh] overflow-y-auto bg-card border-primary/20 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-primary flex items-center gap-2">
              <Swords className="w-5 h-5" /> {t("fleets.initializeOperation")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("fleets.initializeDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fleetName" className="text-xs tracking-widest">
                {t("fleets.opName")}
              </Label>
              <Input
                id="fleetName"
                value={fleetName}
                onChange={(e) => setFleetName(e.target.value)}
                className="bg-background/50 border-border/50 rounded-sm"
                placeholder={t("fleets.opNamePlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fc" className="text-xs tracking-widest">
                {t("fleets.commanderLabel")}
              </Label>
              <Input
                id="fc"
                value={fleetCommander}
                onChange={(e) => setFleetCommander(e.target.value)}
                className="bg-background/50 border-border/50 rounded-sm"
                placeholder={t("fleets.commanderPlaceholder")}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="papCurrency">{tr("发放 PAP 种类", "PAP currency to award")}</Label>
              <select id="papCurrency" className="h-10 rounded-sm border border-border/50 bg-background/50 px-3 text-sm" value={papCurrencyId} onChange={(event) => setPapCurrencyId(event.target.value)}>
                <option value="">{tr("通用 PAP", "Common PAP")}</option>
                {availableCurrencies.map((currency) => <option key={currency.id} value={currency.id}>{currency.name}</option>)}
              </select>
              <p className="text-xs text-muted-foreground">{tr("自定义种类单独入账，不会自动变为通用 PAP；首次发放后不可更改种类。", "Custom PAP is credited separately, not automatically converted. The currency cannot change after the first award.")}</p>
              {currencies.isError && <p className="text-xs text-destructive">{tr("自定义 PAP 种类加载失败，请刷新重试。", "Could not load custom PAP currencies. Refresh to retry.")}</p>}
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="pap" className="text-xs tracking-widest">
                {t("fleets.papValue")}
              </Label>
              <Input
                id="pap"
                type="number"
                min="0.000001"
                max="1000000"
                step="0.000001"
                value={papValue}
                onChange={(e) => setPapValue(e.target.value)}
                className="bg-background/50 border-border/50 rounded-sm"
                placeholder="1"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="fleetFunction" className="text-xs tracking-widest">
                {tr("舰队职能", "FLEET FUNCTION")}
              </Label>
              <Input
                id="fleetFunction"
                value={fleetFunction}
                onChange={(e) => setFleetFunction(e.target.value)}
                className="bg-background/50 border-border/50 rounded-sm"
                placeholder={tr("例如：值守舰队、战略舰队", "e.g. Standing fleet, strategic fleet")}
              />
              <p className="text-[10px] text-muted-foreground">{tr("该职能由创建舰队的 FC/管理员指定，用于区分舰队任务。", "Assigned by the creating FC/administrator to identify the fleet's purpose.")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="identityGroupId" className="text-xs tracking-widest">{tr("战术身份组", "TACTICAL IDENTITY GROUP")}</Label>
              <select id="identityGroupId" className="h-10 rounded-sm border border-border/50 bg-background/50 px-3 text-sm" value={identityGroupId} onChange={(event) => setIdentityGroupId(event.target.value)}>
                <option value="">{tr("通用舰队（不归属身份组）", "General fleet (no identity group)")}</option>
                {tacticalGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
              </select>
              <p className="text-[10px] text-muted-foreground">{tr("组内成员的相关补损会进入该身份组专属模块；非组员仍进入通用补损。", "Matching claims from group members go to the dedicated module; non-members remain in general reimbursement.")}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eveFleetId" className="text-xs tracking-widest">
                {t("fleets.eveFleetId")}
              </Label>
              <div className="flex gap-2">
                <Input
                  id="eveFleetId"
                  value={eveFleetId}
                  onChange={(e) => setEveFleetId(e.target.value)}
                  className="flex-1 bg-background/50 border-border/50 rounded-sm"
                  placeholder={t("fleets.eveFleetIdPlaceholder")}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="shrink-0 rounded-sm font-mono text-[10px] border-amber-500/30 text-amber-400 hover:bg-amber-500/10 px-3 gap-1.5"
                  onClick={handleFetchFleetIdForCreate}
                  disabled={fetchingCreateId}
                >
                  {fetchingCreateId ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Crosshair className="w-3 h-3" />
                  )}
                  {fetchingCreateId ? t("fleets.fetchingFleetId") : t("fleets.fetchFleetId")}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateModalOpen(false)} className="rounded-sm">{t("fleets.abort")}</Button>
            <Button onClick={handleCreateFleet} disabled={createFleet.isPending || !fleetName || !fleetCommander || !validPapAmount(papValue)} className="rounded-sm">
              {createFleet.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("fleets.initialize")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(configuringFleet)} onOpenChange={(open) => { if (!open) setConfiguringFleet(null); }}>
        <DialogContent className="sm:max-w-[480px] max-h-[90vh] overflow-y-auto bg-card border-primary/20 rounded-sm font-mono">
          <DialogHeader><DialogTitle>{tr("舰队设置", "FLEET SETTINGS")}</DialogTitle><DialogDescription>{configuringFleet?.name}</DialogDescription></DialogHeader>
          <div className="space-y-4 py-3">
            <div className="space-y-2"><Label htmlFor="configPapCurrency">{tr("发放 PAP 种类", "PAP currency to award")}</Label><select id="configPapCurrency" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-60" value={configPapCurrencyId} disabled={(configuringFleet?.participantCount ?? 0) > 0} onChange={(event) => setConfigPapCurrencyId(event.target.value)}><option value="">{tr("通用 PAP", "Common PAP")}</option>{(currencies.data?.currencies ?? []).filter((currency) => currency.issuanceEnabled || String(currency.id) === configPapCurrencyId).map((currency) => <option key={currency.id} value={currency.id} disabled={!currency.issuanceEnabled}>{currency.name}{currency.issuanceEnabled ? "" : tr("（暂停发放）", " (issuance paused)")}</option>)}</select><p className="text-xs text-muted-foreground">{tr("已发放 PAP 的舰队不能更改种类，后续数量调整不改写历史发放。", "A fleet with PAP awards cannot change currency. Changing the amount does not rewrite previous awards.")}</p></div>
            <div className="space-y-2"><Label htmlFor="configPapValue">{tr("每次发放数量", "PAP per award")}</Label><Input id="configPapValue" type="number" min="0.000001" max="1000000" step="0.000001" value={configPapValue} onChange={(event) => setConfigPapValue(event.target.value)} /></div>
            <div className="space-y-2"><Label>{tr("舰队职能", "Fleet function")}</Label><Input value={configFunction} onChange={(event) => setConfigFunction(event.target.value)} placeholder={tr("例如：值守舰队", "e.g. Standing fleet")} /></div>
            <div className="space-y-2"><Label>{tr("战术身份组", "Tactical identity group")}</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={configIdentityGroupId} onChange={(event) => setConfigIdentityGroupId(event.target.value)}><option value="">{tr("通用舰队", "General fleet")}</option>{tacticalGroups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}</select></div>
          </div>
          <DialogFooter><Button variant="outline" onClick={() => setConfiguringFleet(null)}>{tr("取消", "Cancel")}</Button><Button onClick={saveFleetConfiguration} disabled={updateFleet.isPending || !configFunction.trim() || (configPapValue !== String(configuringFleet?.papValue) && !validPapAmount(configPapValue))}>{tr("保存", "Save")}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
