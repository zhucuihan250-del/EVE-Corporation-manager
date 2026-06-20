import {
  useListFleets, useCreateFleet, useUpdateFleet, useScanFleetMembers,
  getListFleetsQueryKey, getGetRecentFleetsQueryKey, getGetAdminSummaryQueryKey,
  getGetDashboardSummaryQueryKey, getListUsersQueryKey, getListAllPapRecordsQueryKey,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Loader2, Swords, Plus, Shield, ScanSearch, Crosshair, Radio } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { useLiveFleetCounts } from "@/hooks/use-live-fleet-counts";

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

async function fetchEsiFleetId(): Promise<{ fleetId: string; role: string }> {
  const resp = await fetch("/api/fleets/esi-my-fleet", { credentials: "include" });
  const data = await resp.json();
  if (!resp.ok) throw new Error(data.error || "ESI error");
  return data;
}

export function AdminFleets() {
  const { t } = useTranslation();
  const { data: fleets, isLoading } = useListFleets();
  const createFleet = useCreateFleet();
  const updateFleet = useUpdateFleet();
  const scanFleet = useScanFleetMembers();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [fleetName, setFleetName] = useState("");
  const [fleetCommander, setFleetCommander] = useState("");
  const [papValue, setPapValue] = useState("");
  const [eveFleetId, setEveFleetId] = useState("");
  const [scanningId, setScanningId] = useState<number | null>(null);
  const [fetchingCreateId, setFetchingCreateId] = useState(false);
  const [updatingFleetId, setUpdatingFleetId] = useState<number | null>(null);
  const [standingDownId, setStandingDownId] = useState<number | null>(null);

  const { liveCounts, scanFleet: scanFleetLive } = useLiveFleetCounts(fleets);

  const invalidateAfterScan = () => {
    queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetRecentFleetsQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetAdminSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListAllPapRecordsQueryKey() });
  };


  const activeScannableFleets = (fleets ?? []).filter(f => f.isActive && f.eveFleetId);

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
    if (!fleetName || !fleetCommander || !papValue) return;
    createFleet.mutate(
      { data: { name: fleetName, fleetCommander, papValue: Number(papValue), eveFleetId: eveFleetId || null } },
      {
        onSuccess: () => {
          toast({ title: t("fleets.fleetCreated"), description: t("fleets.newOperationRegistered") });
          invalidateAfterScan();
          setCreateModalOpen(false);
          setFleetName("");
          setFleetCommander("");
          setPapValue("");
          setEveFleetId("");
        }
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
              if (data.awarded > 0) {
                toast({
                  title: t("fleets.scanComplete"),
                  description: t("fleets.scanCompleteDesc", {
                    esiMemberCount: data.esiMemberCount ?? 0,
                    awarded: data.awarded,
                    skipped: data.skipped,
                    notFound: data.notFound,
                    autoRegistered: (data as { autoRegistered?: number }).autoRegistered ?? 0,
                  }),
                });
              }
              resolve();
            },
            onError: () => resolve(),
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
          ) : !fleets?.length ? (
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
                {fleets.map((fleet) => (
                  <TableRow key={fleet.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-foreground">
                      <div className="flex flex-col">
                        <span>{fleet.name}</span>
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
                    </TableCell>
                    <TableCell className="font-mono text-sm text-right text-muted-foreground">
                      {fleet.isActive
                        ? (liveCounts[fleet.id] ?? <span className="text-muted-foreground/40">—</span>)
                        : (fleet.participantCount || 0)}
                    </TableCell>
                    <TableCell className="text-right">
                      {fleet.isActive && (
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
        <DialogContent className="sm:max-w-[425px] bg-card border-primary/20 rounded-sm font-mono">
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
              <Label htmlFor="pap" className="text-xs tracking-widest">
                {t("fleets.papValue")}
              </Label>
              <Input
                id="pap"
                type="number"
                value={papValue}
                onChange={(e) => setPapValue(e.target.value)}
                className="bg-background/50 border-border/50 rounded-sm"
                placeholder="1"
              />
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
            <Button onClick={handleCreateFleet} disabled={createFleet.isPending || !fleetName || !fleetCommander || !papValue} className="rounded-sm">
              {createFleet.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("fleets.initialize")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
