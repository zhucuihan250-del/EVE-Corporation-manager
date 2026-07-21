import {
  useListUsers, useUpdateUserRole, useAdjustUserPap, getListUsersQueryKey,
  useGetUserCharacters, useDeleteCharacter, useDeleteUser, useGetMe,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldAlert, Shield, MoreHorizontal, Activity, Users, Trash2, Star, AlertTriangle, Crown, Sword, Search, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "react-i18next";

const ROLE_LEVELS = ["member", "fc", "admin", "controller"] as const;
type Role = typeof ROLE_LEVELS[number];

function hasRole(userRole: string, minRole: Role): boolean {
  return ROLE_LEVELS.indexOf(userRole as Role) >= ROLE_LEVELS.indexOf(minRole);
}

const ROLE_CONFIG: Record<Role, { label: string; color: string; icon: React.ReactNode }> = {
  member:     { label: "MEMBER",     color: "secondary",    icon: <Shield className="w-3 h-3" /> },
  fc:         { label: "FC",         color: "outline-blue", icon: <Sword className="w-3 h-3" /> },
  admin:      { label: "ADMIN",      color: "destructive",  icon: <ShieldAlert className="w-3 h-3" /> },
  controller: { label: "CONTROLLER", color: "controller",   icon: <Crown className="w-3 h-3" /> },
};

function RoleBadge({ role }: { role: string }) {
  const cfg = ROLE_CONFIG[role as Role] ?? ROLE_CONFIG.member;
  const colorClass =
    role === "controller" ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/40" :
    role === "admin"      ? "bg-destructive/20 text-destructive border-destructive/40" :
    role === "fc"         ? "bg-blue-500/20 text-blue-400 border-blue-500/40" :
                            "bg-secondary/40 text-muted-foreground border-border/40";
  return (
    <span className={`inline-flex items-center gap-1 font-mono text-[10px] px-2 py-0.5 rounded-sm border ${colorClass}`}>
      {cfg.icon}
      {cfg.label}
    </span>
  );
}

export function AdminUsers() {
  const { t } = useTranslation();
  const { data: me } = useGetMe();
  const { data: users, isLoading } = useListUsers({ query: { queryKey: ["adminUsers"] } });
  const updateUserRole = useUpdateUserRole();
  const adjustPap = useAdjustUserPap();
  const deleteCharacter = useDeleteCharacter();
  const deleteUser = useDeleteUser();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const amController = me ? hasRole(me.role, "controller") : false;
  const [searchQuery, setSearchQuery] = useState("");

  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<number | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const [charsModalOpen, setCharsModalOpen] = useState(false);
  const [charsUserId, setCharsUserId] = useState<number | null>(null);
  const [charsUserName, setCharsUserName] = useState("");

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: number; name: string } | null>(null);
  const [deleteConfirmInput, setDeleteConfirmInput] = useState("");

  const visibleUsers = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLocaleLowerCase();
    if (!normalizedQuery) return users ?? [];

    return (users ?? []).filter((user) =>
      (user.eveCharacterName ?? "").toLocaleLowerCase().includes(normalizedQuery),
    );
  }, [searchQuery, users]);

  const { data: userCharacters, isLoading: charsLoading } = useGetUserCharacters(
    charsUserId ?? 0,
    { query: { enabled: !!charsUserId && charsModalOpen, queryKey: ["userCharacters", charsUserId] } },
  );

  const handleRoleChange = (userId: number, newRole: Role) => {
    if (!amController) {
      toast({ title: t("personnel.roleChangeControllerOnly"), variant: "destructive" });
      return;
    }
    updateUserRole.mutate(
      { id: userId, data: { role: newRole } },
      {
        onSuccess: () => {
          toast({ title: t("personnel.roleUpdated"), description: t("personnel.roleUpdatedDesc") });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
        onError: () => {
          toast({ title: t("personnel.roleChangeControllerOnly"), variant: "destructive" });
        },
      }
    );
  };

  const handleAdjustPap = () => {
    if (!selectedUser || !adjustAmount || !adjustReason) return;
    adjustPap.mutate(
      { id: selectedUser, data: { amount: Number(adjustAmount), reason: adjustReason } },
      {
        onSuccess: () => {
          toast({ title: t("personnel.papAdjusted"), description: t("personnel.papAdjustedDesc") });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          setAdjustModalOpen(false);
          setAdjustAmount("");
          setAdjustReason("");
        },
      }
    );
  };

  const handleOpenCharsModal = (userId: number, userName: string) => {
    setCharsUserId(userId);
    setCharsUserName(userName);
    setCharsModalOpen(true);
  };

  const handleDeleteChar = (charId: number) => {
    deleteCharacter.mutate(
      { id: charId },
      {
        onSuccess: () => {
          toast({ title: t("personnel.charRemoved"), description: t("personnel.charRemovedDesc") });
          queryClient.invalidateQueries({ queryKey: ["userCharacters", charsUserId] });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        },
        onError: () => {
          toast({ title: t("personnel.charRemoveFailed"), variant: "destructive" });
        },
      }
    );
  };

  const handleOpenDeleteModal = (userId: number, userName: string) => {
    setDeleteTarget({ id: userId, name: userName });
    setDeleteConfirmInput("");
    setDeleteModalOpen(true);
  };

  const handleDeleteUser = () => {
    if (!deleteTarget) return;
    deleteUser.mutate(
      { id: deleteTarget.id },
      {
        onSuccess: () => {
          toast({ title: t("personnel.userDeleted"), description: t("personnel.userDeletedDesc") });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          setDeleteModalOpen(false);
          setDeleteTarget(null);
        },
        onError: () => {
          toast({ title: t("personnel.userDeleteFailed"), variant: "destructive" });
        },
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">{t("personnel.title")}</h1>
        <p className="text-muted-foreground font-mono text-sm">{t("personnel.subtitle")}</p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">{t("personnel.activeMembers")}</CardTitle>
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("personnel.searchPlaceholder")}
              aria-label={t("personnel.searchPlaceholder")}
              className="h-9 pl-9 pr-9 bg-background/50 border-border/50 rounded-sm font-mono text-xs"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label={t("personnel.clearSearch")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground transition-colors"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !users?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              {t("personnel.noPersonnel")}
            </div>
          ) : !visibleUsers.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              {t("personnel.noSearchResults")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("personnel.pilotName")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">{t("personnel.role")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("personnel.totalPap")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("personnel.redeemable")}</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("personnel.actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleUsers.map((user) => (
                  <TableRow key={user.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-foreground">
                      {user.eveCharacterName || `Unknown (ID: ${user.eveCharacterId})`}
                    </TableCell>
                    <TableCell>
                      <RoleBadge role={user.role} />
                    </TableCell>
                    <TableCell className="font-mono font-bold text-right text-muted-foreground">
                      {user.totalPap}
                    </TableCell>
                    <TableCell className="font-mono font-bold text-right text-emerald-400">
                      {user.redeemablePap}
                    </TableCell>
                    <TableCell className="text-right">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" className="h-8 w-8 p-0">
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="bg-card border-border/50 rounded-sm font-mono">
                          <DropdownMenuLabel className="text-xs tracking-widest text-muted-foreground">{t("personnel.commands")}</DropdownMenuLabel>
                          <DropdownMenuSeparator className="bg-border/50" />
                          <DropdownMenuItem
                            onClick={() => { setSelectedUser(user.id); setAdjustModalOpen(true); }}
                            className="text-xs cursor-pointer focus:bg-primary/20"
                          >
                            <Activity className="mr-2 h-4 w-4" />
                            <span>{t("personnel.adjustPap")}</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleOpenCharsModal(user.id, user.eveCharacterName || String(user.id))}
                            className="text-xs cursor-pointer focus:bg-primary/20"
                          >
                            <Users className="mr-2 h-4 w-4" />
                            <span>{t("personnel.manageCharacters")}</span>
                          </DropdownMenuItem>
                          {amController && (
                            <DropdownMenuSub>
                              <DropdownMenuSubTrigger className="text-xs cursor-pointer focus:bg-primary/20">
                                <Crown className="mr-2 h-4 w-4 text-yellow-400" />
                                <span>{t("personnel.toggleAdmin")}</span>
                              </DropdownMenuSubTrigger>
                              <DropdownMenuSubContent className="bg-card border-border/50 rounded-sm font-mono">
                                {ROLE_LEVELS.map((r) => (
                                  <DropdownMenuItem
                                    key={r}
                                    onClick={() => handleRoleChange(user.id, r)}
                                    className={`text-xs cursor-pointer focus:bg-primary/20 ${user.role === r ? "opacity-50 pointer-events-none" : ""}`}
                                  >
                                    <RoleBadge role={r} />
                                    {user.role === r && <span className="ml-2 text-muted-foreground">✓</span>}
                                  </DropdownMenuItem>
                                ))}
                              </DropdownMenuSubContent>
                            </DropdownMenuSub>
                          )}
                          <DropdownMenuSeparator className="bg-border/50" />
                          <DropdownMenuItem
                            onClick={() => handleOpenDeleteModal(user.id, user.eveCharacterName || String(user.id))}
                            className="text-xs cursor-pointer text-destructive focus:bg-destructive/20 focus:text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            <span>{t("personnel.deleteUser")}</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* PAP Adjustment Modal */}
      <Dialog open={adjustModalOpen} onOpenChange={setAdjustModalOpen}>
        <DialogContent className="sm:max-w-[425px] bg-card border-primary/20 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-primary">{t("personnel.manualPapAdjustment")}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t("personnel.manualPapDesc")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="amount" className="text-right text-xs tracking-widest">{t("personnel.amount")}</Label>
              <Input
                id="amount"
                type="number"
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("personnel.amountPlaceholder")}
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="reason" className="text-right text-xs tracking-widest">{t("personnel.reason")}</Label>
              <Input
                id="reason"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder={t("personnel.reasonPlaceholder")}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustModalOpen(false)} className="rounded-sm">{t("personnel.cancel")}</Button>
            <Button onClick={handleAdjustPap} disabled={adjustPap.isPending || !adjustAmount || !adjustReason} className="rounded-sm">
              {adjustPap.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("personnel.execute")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manage Characters Modal */}
      <Dialog open={charsModalOpen} onOpenChange={setCharsModalOpen}>
        <DialogContent className="sm:max-w-[560px] bg-card border-primary/20 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-primary">
              {t("personnel.charactersTitle")} — {charsUserName}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs">{t("personnel.charactersDesc")}</DialogDescription>
          </DialogHeader>
          <div className="py-2">
            {charsLoading ? (
              <div className="flex justify-center py-6"><Loader2 className="w-5 h-5 animate-spin text-primary" /></div>
            ) : !userCharacters?.length ? (
              <p className="text-center text-muted-foreground text-sm py-6">{t("personnel.noCharacters")}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-border/30 hover:bg-transparent">
                    <TableHead className="font-mono text-xs text-muted-foreground">{t("personnel.charName")}</TableHead>
                    <TableHead className="font-mono text-xs text-muted-foreground">{t("personnel.charCorp")}</TableHead>
                    <TableHead className="font-mono text-xs text-muted-foreground">{t("personnel.charType")}</TableHead>
                    <TableHead className="font-mono text-xs text-muted-foreground text-right">{t("personnel.actions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {userCharacters.map((char) => (
                    <TableRow key={char.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5">
                      <TableCell className="font-mono text-sm text-foreground">
                        <span className="flex items-center gap-2">
                          {char.isMain && <Star className="w-3 h-3 text-yellow-400 shrink-0" />}
                          {char.eveCharacterName || `ID: ${char.eveCharacterId}`}
                        </span>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">{char.corporationName || "—"}</TableCell>
                      <TableCell>
                        <Badge variant={char.isMain ? "default" : "secondary"} className="font-mono text-[10px] rounded-sm">
                          {char.isMain ? t("personnel.mainChar") : t("personnel.altChar")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-destructive hover:text-destructive hover:bg-destructive/10 rounded-sm"
                          onClick={() => handleDeleteChar(char.id)}
                          disabled={deleteCharacter.isPending}
                        >
                          <Trash2 className="w-3.5 h-3.5 mr-1" />
                          {t("personnel.removeChar")}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCharsModalOpen(false)} className="rounded-sm text-xs">{t("personnel.cancel")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete User Confirmation Modal */}
      <Dialog open={deleteModalOpen} onOpenChange={(open) => { setDeleteModalOpen(open); if (!open) setDeleteConfirmInput(""); }}>
        <DialogContent className="sm:max-w-[460px] bg-card border-destructive/40 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-destructive flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              {t("personnel.deleteUserConfirmTitle", { name: deleteTarget?.name ?? "" })}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground text-xs leading-relaxed">
              {t("personnel.deleteUserConfirmDesc")}
            </DialogDescription>
          </DialogHeader>
          <div className="py-3">
            <Label className="text-xs tracking-widest text-muted-foreground mb-2 block">
              输入 <span className="text-destructive font-bold">DELETE</span> 确认删除
            </Label>
            <Input
              value={deleteConfirmInput}
              onChange={(e) => setDeleteConfirmInput(e.target.value)}
              className="bg-background/50 border-destructive/40 rounded-sm font-mono text-sm"
              placeholder="DELETE"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteModalOpen(false)} className="rounded-sm text-xs">{t("personnel.cancel")}</Button>
            <Button
              variant="destructive"
              onClick={handleDeleteUser}
              disabled={deleteUser.isPending || deleteConfirmInput !== "DELETE"}
              className="rounded-sm text-xs tracking-wider"
            >
              {deleteUser.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : t("personnel.deleteUserConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
