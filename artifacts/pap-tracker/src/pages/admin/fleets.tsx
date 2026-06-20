import { useListFleets, useCreateFleet, useUpdateFleet, useScanFleetMembers, getListFleetsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Loader2, Swords, Plus, Shield, ScanSearch } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

export function AdminFleets() {
  const { t } = useTranslation();
  const { data: fleets, isLoading } = useListFleets({ query: { queryKey: ["adminFleets"] } });
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

  const handleCreateFleet = () => {
    if (!fleetName || !fleetCommander || !papValue) return;
    createFleet.mutate(
      { data: { name: fleetName, fleetCommander, papValue: Number(papValue), eveFleetId: eveFleetId || null } },
      {
        onSuccess: () => {
          toast({ title: t("fleets.fleetCreated"), description: t("fleets.newOperationRegistered") });
          queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
          setCreateModalOpen(false);
          setFleetName("");
          setFleetCommander("");
          setPapValue("");
          setEveFleetId("");
        }
      }
    );
  };

  const handleEndFleet = (fleetId: number) => {
    updateFleet.mutate(
      { id: fleetId, data: { isActive: false, endedAt: new Date().toISOString() } },
      {
        onSuccess: () => {
          toast({ title: t("fleets.fleetEnded"), description: t("fleets.operationComplete") });
          queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
        }
      }
    );
  };

  const handleScanFleet = (fleetId: number, hasEveId: boolean) => {
    if (!hasEveId) {
      toast({ title: t("fleets.scanFailed"), description: t("fleets.noEveFleetId"), variant: "destructive" });
      return;
    }
    setScanningId(fleetId);
    scanFleet.mutate(
      { id: fleetId },
      {
        onSuccess: (data) => {
          toast({
            title: t("fleets.scanComplete"),
            description: t("fleets.scanCompleteDesc", {
              awarded: data.awarded,
              skipped: data.skipped,
              notFound: data.notFound,
            }),
          });
          queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
        },
        onError: () => {
          toast({ title: t("fleets.scanFailed"), description: t("fleets.scanFailedDesc"), variant: "destructive" });
        },
        onSettled: () => setScanningId(null),
      }
    );
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
                        {fleet.eveFleetId && (
                          <span className="text-[10px] text-muted-foreground/60 font-mono mt-0.5">ID: {fleet.eveFleetId}</span>
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
                      {fleet.participantCount || 0}
                    </TableCell>
                    <TableCell className="text-right">
                      {fleet.isActive && (
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-8 rounded-sm font-mono text-[10px] border-primary/30 text-primary hover:bg-primary/10"
                            onClick={() => handleScanFleet(fleet.id, !!fleet.eveFleetId)}
                            disabled={scanningId === fleet.id}
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
                            onClick={() => handleEndFleet(fleet.id)}
                            disabled={updateFleet.isPending}
                          >
                            {t("fleets.standDown")}
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
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="fleetName" className="text-right text-xs tracking-widest">
                {t("fleets.opName")}
              </Label>
              <Input
                id="fleetName"
                value={fleetName}
                onChange={(e) => setFleetName(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("fleets.opNamePlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="fc" className="text-right text-xs tracking-widest">
                {t("fleets.commanderLabel")}
              </Label>
              <Input
                id="fc"
                value={fleetCommander}
                onChange={(e) => setFleetCommander(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("fleets.commanderPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="pap" className="text-right text-xs tracking-widest">
                {t("fleets.papValue")}
              </Label>
              <Input
                id="pap"
                type="number"
                value={papValue}
                onChange={(e) => setPapValue(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="1"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="eveFleetId" className="text-right text-xs tracking-widest leading-tight">
                {t("fleets.eveFleetId")}
              </Label>
              <Input
                id="eveFleetId"
                value={eveFleetId}
                onChange={(e) => setEveFleetId(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("fleets.eveFleetIdPlaceholder")}
              />
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
