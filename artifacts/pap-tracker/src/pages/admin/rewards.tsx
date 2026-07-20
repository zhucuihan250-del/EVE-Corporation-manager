import { useListRewards, useCreateReward, useUpdateReward, useDeleteReward, getListRewardsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Loader2, Plus, Gift, Edit2, Trash2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

export function AdminRewards() {
  const { t } = useTranslation();
  const { data: rewards, isLoading } = useListRewards({ query: { queryKey: ["adminRewards"] } });
  const createReward = useCreateReward();
  const updateReward = useUpdateReward();
  const deleteReward = useDeleteReward();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [modalOpen, setModalOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [currentId, setCurrentId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [papCost, setPapCost] = useState("");
  const [stock, setStock] = useState("");

  const invalidateRewardQueries = () => {
    queryClient.invalidateQueries({ queryKey: ["adminRewards"] });
    queryClient.invalidateQueries({ queryKey: ["rewards"] });
    queryClient.invalidateQueries({ queryKey: getListRewardsQueryKey() });
  };

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
            toast({ title: t("adminRewards.assetUpdated"), description: t("adminRewards.assetUpdatedDesc") });
            invalidateRewardQueries();
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
            toast({ title: t("adminRewards.assetCreated"), description: t("adminRewards.assetCreatedDesc") });
            invalidateRewardQueries();
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
          toast({ title: t("adminRewards.statusUpdated"), description: t("adminRewards.statusUpdatedDesc") });
          invalidateRewardQueries();
        }
      }
    );
  };

  const handleDelete = () => {
    if (!deleteTarget) return;

    deleteReward.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          toast({ title: t("adminRewards.assetDeleted"), description: t("adminRewards.assetDeletedDesc") });
          invalidateRewardQueries();
          setDeleteTarget(null);
        },
        onError: () => {
          toast({ title: t("adminRewards.assetDeleteFailed"), variant: "destructive" });
        },
      }
    );
  };

  const handleDeleteFromEdit = () => {
    if (currentId === null) return;

    setModalOpen(false);
    setDeleteTarget({ id: currentId, name });
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex justify-between items-start">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("adminRewards.title")}</h1>
          <p className="text-muted-foreground font-mono text-sm">{t("adminRewards.subtitle")}</p>
        </div>
        <Button onClick={() => { resetForm(); setModalOpen(true); }} className="font-mono rounded-sm text-xs tracking-wider">
          <Plus className="w-4 h-4 mr-2" /> {t("adminRewards.addAsset")}
        </Button>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">{t("adminRewards.assetInventory")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !rewards?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              {t("adminRewards.noAssets")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("adminRewards.assetName")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("adminRewards.cost")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("adminRewards.stock")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("adminRewards.status")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("adminRewards.actions")}</TableHead>
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
                      {reward.stock === null ? t("adminRewards.unlimited") : reward.stock}
                    </TableCell>
                    <TableCell>
                      <Badge variant={reward.isAvailable ? 'default' : 'secondary'} className="font-mono text-[10px] rounded-sm cursor-pointer" onClick={() => handleToggleAvailability(reward.id, reward.isAvailable)}>
                        {reward.isAvailable ? t("adminRewards.available") : t("adminRewards.restricted")}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-primary"
                        onClick={() => openEdit(reward)}
                        aria-label={t("adminRewards.editAsset", { name: reward.name })}
                        disabled={deleteReward.isPending}
                      >
                        <Edit2 className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                        onClick={() => setDeleteTarget({ id: reward.id, name: reward.name })}
                        aria-label={t("adminRewards.deleteAsset", { name: reward.name })}
                        disabled={deleteReward.isPending}
                      >
                        <Trash2 className="h-4 w-4" />
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
              <Gift className="w-5 h-5" /> {editMode ? t("adminRewards.modifyAsset") : t("adminRewards.registerAsset")}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t("adminRewards.defineParams")}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="name" className="text-right text-xs tracking-widest">{t("adminRewards.name")}</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("adminRewards.namePlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="desc" className="text-right text-xs tracking-widest">{t("adminRewards.desc")}</Label>
              <Input
                id="desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("adminRewards.descPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="cost" className="text-right text-xs tracking-widest">{t("adminRewards.papCost")}</Label>
              <Input
                id="cost"
                type="number"
                value={papCost}
                onChange={(e) => setPapCost(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("adminRewards.papCostPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="stock" className="text-right text-xs tracking-widest">{t("adminRewards.stockLabel")}</Label>
              <Input
                id="stock"
                type="number"
                value={stock}
                onChange={(e) => setStock(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("adminRewards.stockPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            {editMode && (
              <Button
                variant="destructive"
                onClick={handleDeleteFromEdit}
                disabled={updateReward.isPending || deleteReward.isPending}
                className="rounded-sm"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                {t("adminRewards.removeAsset")}
              </Button>
            )}
            <Button variant="outline" onClick={() => setModalOpen(false)} className="rounded-sm">{t("adminRewards.cancel")}</Button>
            <Button onClick={handleSave} disabled={createReward.isPending || updateReward.isPending || !name || !papCost} className="rounded-sm">
              {createReward.isPending || updateReward.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("adminRewards.saveAsset")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteReward.isPending) setDeleteTarget(null);
        }}
      >
        <DialogContent className="sm:max-w-[460px] bg-card border-destructive/40 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-destructive flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {t("adminRewards.deleteAssetConfirmTitle", { name: deleteTarget?.name ?? "" })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
              {t("adminRewards.deleteAssetConfirmDesc")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteReward.isPending}
              className="rounded-sm text-xs"
            >
              {t("adminRewards.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteReward.isPending}
              className="rounded-sm text-xs tracking-wider"
            >
              {deleteReward.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("adminRewards.deleteAssetConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
