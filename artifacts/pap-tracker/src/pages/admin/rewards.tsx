import { useListRewards, useCreateReward, useUpdateReward, getListRewardsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Plus, Gift, Edit2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminRewards() {
  const { data: rewards, isLoading } = useListRewards({ query: { queryKey: ["adminRewards"] } });
  const createReward = useCreateReward();
  const updateReward = useUpdateReward();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [currentId, setCurrentId] = useState<number | null>(null);
  
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [papCost, setPapCost] = useState("");
  const [stock, setStock] = useState("");

  const resetForm = () => {
    setName("");
    setDescription("");
    setPapCost("");
    setStock("");
    setCurrentId(null);
    setEditMode(false);
  };

  const handleSave = () => {
    if (!name || !papCost) return;
    
    const payload = {
      name,
      description,
      papCost: Number(papCost),
      stock: stock ? Number(stock) : null
    };

    if (editMode && currentId) {
      updateReward.mutate(
        { id: currentId, data: payload },
        {
          onSuccess: () => {
            toast({ title: "Asset Updated", description: "Requisition item modified." });
            queryClient.invalidateQueries({ queryKey: getListRewardsQueryKey() });
            setModalOpen(false);
            resetForm();
          }
        }
      );
    } else {
      createReward.mutate(
        { data: payload },
        {
          onSuccess: () => {
            toast({ title: "Asset Created", description: "New requisition item added to catalog." });
            queryClient.invalidateQueries({ queryKey: getListRewardsQueryKey() });
            setModalOpen(false);
            resetForm();
          }
        }
      );
    }
  };

  const openEdit = (reward: any) => {
    setEditMode(true);
    setCurrentId(reward.id);
    setName(reward.name);
    setDescription(reward.description || "");
    setPapCost(reward.papCost.toString());
    setStock(reward.stock !== null ? reward.stock.toString() : "");
    setModalOpen(true);
  };

  const handleToggleAvailability = (id: number, currentAvailable: boolean) => {
    updateReward.mutate(
      { id, data: { isAvailable: !currentAvailable } },
      {
        onSuccess: () => {
          toast({ title: "Status Updated", description: "Asset availability toggled." });
          queryClient.invalidateQueries({ queryKey: getListRewardsQueryKey() });
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Requisition Catalog</h1>
          <p className="text-muted-foreground font-mono text-sm">Manage assets available for pilot redemption</p>
        </div>
        <Button onClick={() => { resetForm(); setModalOpen(true); }} className="font-mono rounded-sm text-xs tracking-wider">
          <Plus className="w-4 h-4 mr-2" /> ADD ASSET
        </Button>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Asset Inventory</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !rewards?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              No assets in catalog.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">ASSET NAME</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">COST</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">STOCK</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">STATUS</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">ACTIONS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rewards.map((reward) => (
                  <TableRow key={reward.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-foreground">
                      <div className="flex flex-col">
                        <span>{reward.name}</span>
                        <span className="text-xs text-muted-foreground line-clamp-1">{reward.description}</span>
                      </div>
                    </TableCell>
                    <TableCell className="font-mono font-bold text-primary">
                      {reward.papCost}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {reward.stock === null ? 'UNLIMITED' : reward.stock}
                    </TableCell>
                    <TableCell>
                      <Badge variant={reward.isAvailable ? 'default' : 'secondary'} className="font-mono text-[10px] rounded-sm cursor-pointer" onClick={() => handleToggleAvailability(reward.id, reward.isAvailable)}>
                        {reward.isAvailable ? 'AVAILABLE' : 'RESTRICTED'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-primary"
                        onClick={() => openEdit(reward)}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={modalOpen} onOpenChange={setModalOpen}>
        <DialogContent className="sm:max-w-[425px] bg-card border-primary/20 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-primary flex items-center gap-2">
              <Gift className="w-5 h-5" /> {editMode ? 'Modify Asset' : 'Register Asset'}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Define the parameters for this requisition item.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right text-xs tracking-widest">NAME</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="e.g. 500 PLEX"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="desc" className="text-right text-xs tracking-widest">DESC</Label>
              <Input
                id="desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="Optional details"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="cost" className="text-right text-xs tracking-widest">PAP COST</Label>
              <Input
                id="cost"
                type="number"
                value={papCost}
                onChange={(e) => setPapCost(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="e.g. 10"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="stock" className="text-right text-xs tracking-widest">STOCK</Label>
              <Input
                id="stock"
                type="number"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="Leave empty for infinite"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)} className="rounded-sm">CANCEL</Button>
            <Button onClick={handleSave} disabled={createReward.isPending || updateReward.isPending || !name || !papCost} className="rounded-sm">
              {createReward.isPending || updateReward.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "SAVE ASSET"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}