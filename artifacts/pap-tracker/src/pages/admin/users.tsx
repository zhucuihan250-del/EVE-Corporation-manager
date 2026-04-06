import { useListUsers, useUpdateUserRole, useAdjustUserPap, getListUsersQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Loader2, ShieldAlert, Shield, MoreHorizontal, Activity } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function AdminUsers() {
  const { data: users, isLoading } = useListUsers({ query: { queryKey: ["adminUsers"] } });
  const updateUserRole = useUpdateUserRole();
  const adjustPap = useAdjustUserPap();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [adjustModalOpen, setAdjustModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<number | null>(null);
  const [adjustAmount, setAdjustAmount] = useState("");
  const [adjustReason, setAdjustReason] = useState("");

  const handleRoleToggle = (userId: number, currentRole: 'admin' | 'member') => {
    const newRole = currentRole === 'admin' ? 'member' : 'admin';
    updateUserRole.mutate(
      { id: userId, data: { role: newRole } },
      {
        onSuccess: () => {
          toast({ title: "Role Updated", description: "User permissions have been updated." });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
        }
      }
    );
  };

  const handleAdjustPap = () => {
    if (!selectedUser || !adjustAmount || !adjustReason) return;
    adjustPap.mutate(
      { id: selectedUser, data: { amount: Number(adjustAmount), reason: adjustReason } },
      {
        onSuccess: () => {
          toast({ title: "PAP Adjusted", description: "Manual points adjustment applied." });
          queryClient.invalidateQueries({ queryKey: getListUsersQueryKey() });
          setAdjustModalOpen(false);
          setAdjustAmount("");
          setAdjustReason("");
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Personnel Roster</h1>
        <p className="text-muted-foreground font-mono text-sm">Manage user access and manual point adjustments</p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Active Members</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !users?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              No personnel records found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">PILOT NAME</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">ROLE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">TOTAL PAP</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">REDEEMABLE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">ACTIONS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((user) => (
                  <TableRow key={user.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-foreground">
                      {user.eveCharacterName || `Unknown (ID: ${user.eveCharacterId})`}
                    </TableCell>
                    <TableCell>
                      <Badge variant={user.role === 'admin' ? 'destructive' : 'secondary'} className="font-mono text-[10px] rounded-sm flex w-fit items-center gap-1">
                        {user.role === 'admin' ? <ShieldAlert className="w-3 h-3" /> : <Shield className="w-3 h-3" />}
                        {user.role.toUpperCase()}
                      </Badge>
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
                          <DropdownMenuLabel className="text-xs tracking-widest text-muted-foreground">Commands</DropdownMenuLabel>
                          <DropdownMenuSeparator className="bg-border/50" />
                          <DropdownMenuItem 
                            onClick={() => {
                              setSelectedUser(user.id);
                              setAdjustModalOpen(true);
                            }}
                            className="text-xs cursor-pointer focus:bg-primary/20"
                          >
                            <Activity className="mr-2 h-4 w-4" />
                            <span>Adjust PAP</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={() => handleRoleToggle(user.id, user.role)}
                            className="text-xs cursor-pointer focus:bg-primary/20"
                          >
                            <Shield className="mr-2 h-4 w-4" />
                            <span>Toggle Admin</span>
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

      <Dialog open={adjustModalOpen} onOpenChange={setAdjustModalOpen}>
        <DialogContent className="sm:max-w-[425px] bg-card border-primary/20 rounded-sm font-mono">
          <DialogHeader>
            <DialogTitle className="tracking-wider uppercase text-primary">Manual PAP Adjustment</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Add or subtract PAP directly from the selected pilot's balance. Use negative numbers to deduct.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="amount" className="text-right text-xs tracking-widest">
                AMOUNT
              </Label>
              <Input
                id="amount"
                type="number"
                value={adjustAmount}
                onChange={(e) => setAdjustAmount(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="e.g. 5 or -10"
              />
            </div>
            <div className="grid grid-cols-4 items-center gap-4">
              <Label htmlFor="reason" className="text-right text-xs tracking-widest">
                REASON
              </Label>
              <Input
                id="reason"
                value={adjustReason}
                onChange={(e) => setAdjustReason(e.target.value)}
                className="col-span-3 bg-background/50 border-border/50 rounded-sm"
                placeholder="Brief justification"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdjustModalOpen(false)} className="rounded-sm">CANCEL</Button>
            <Button onClick={handleAdjustPap} disabled={adjustPap.isPending || !adjustAmount || !adjustReason} className="rounded-sm">
              {adjustPap.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : "EXECUTE"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}