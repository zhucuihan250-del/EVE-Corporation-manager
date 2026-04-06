import { useListFleets, useCreateFleet, useUpdateFleet, getListFleetsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Loader2, Swords, Plus, Shield } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminFleets() {
  const { data: fleets, isLoading } = useListFleets({ query: { queryKey: ["adminFleets"] } });
  const createFleet = useCreateFleet();
  const updateFleet = useUpdateFleet();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [fleetName, setFleetName] = useState("");
  const [fleetCommander, setFleetCommander] = useState("");
  const [papValue, setPapValue] = useState("");

  const handleCreateFleet = () => {
    if (!fleetName || !fleetCommander || !papValue) return;
    createFleet.mutate(
      { data: { name: fleetName, fleetCommander, papValue: Number(papValue) } },
      {
        onSuccess: () => {
          toast({ title: "Fleet Created", description: "New operation registered." });
          queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
          setCreateModalOpen(false);
          setFleetName("");
          setFleetCommander("");
          setPapValue("");
        }
      }
    );
  };

  const handleEndFleet = (fleetId: number) => {
    updateFleet.mutate(
      { id: fleetId, data: { isActive: false, endedAt: new Date().toISOString() } },
      {
        onSuccess: () => {
          toast({ title: "Fleet Ended", description: "Operation marked as complete." });
          queryClient.invalidateQueries({ queryKey: getListFleetsQueryKey() });
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Fleet Operations</h1>
          <p className="text-muted-foreground font-mono text-sm">Command active fleets and manage participation</p>
        </div>
        <Button onClick={() => setCreateModalOpen(true)} className="font-mono rounded-sm text-xs tracking-wider">
          <Plus className="w-4 h-4 mr-2" /> NEW OPERATION
        </Button>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Combat Registry</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !fleets?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              No registered fleets.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">OPERATION</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">COMMANDER</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">STATUS</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">VALUE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">PILOTS</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">ACTIONS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {fleets.map((fleet) => (
                  <TableRow key={fleet.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-foreground">
                      <div className="flex flex-col">
                        <span>{fleet.name}</span>
                        <span className="text-xs text-muted-foreground">{format(new Date(fleet.createdAt), "MMM dd, HH:mm")}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground flex items-center gap-2 mt-2">
                      <Shield className="w-3 h-3 text-primary" /> {fleet.fleetCommander}
                    </TableCell>
                    <TableCell>
                      <Badge variant={fleet.isActive ? 'default' : 'secondary'} className="font-mono text-[10px] rounded-sm">
                        {fleet.isActive ? 'ACTIVE' : 'CONCLUDED'}
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
                        <Button 
                          variant="destructive" 
                          size="sm" 
                          className="h-8 rounded-sm font-mono text-[10px]"
                          onClick={() => handleEndFleet(fleet.id)}
                          disabled={updateFleet.isPending}
                        >
                          STAND DOWN
                        </Button>
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
              <Swords className="w-5 h-5" /> Initialize Operation
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Register a new fleet to begin tracking participant activity.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="fleetName" className="text-right text-xs tracking-widest">
                OP NAME
              </Label>
              <Input
                id="fleetName"
                value={fleetName}
                onChange={(e) => setFleetName(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="e.g. CTA - Jita Defense"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="fc" className="text-right text-xs tracking-widest">
                COMMANDER
              </Label>
              <Input
                id="fc"
                value={fleetCommander}
                onChange={(e) => setFleetCommander(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="FC Name"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="pap" className="text-right text-xs tracking-widest">
                PAP VALUE
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateModalOpen(false)} className="rounded-sm">ABORT</Button>
            <Button onClick={handleCreateFleet} disabled={createFleet.isPending || !fleetName || !fleetCommander || !papValue} className="rounded-sm">
              {createFleet.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "INITIALIZE"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}