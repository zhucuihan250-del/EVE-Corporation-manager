import { useListAllRedemptions, useUpdateRedemption, getListAllRedemptionsQueryKey } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { format } from "date-fns";
import { Loader2, CheckCircle, XCircle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";

export function AdminRedemptions() {
  const { data: redemptions, isLoading } = useListAllRedemptions({
    query: {
      queryKey: ["adminRedemptions"]
    }
  });
  const updateRedemption = useUpdateRedemption();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleUpdateStatus = (id: number, status: "fulfilled" | "cancelled", pilotName: string | null) => {
    updateRedemption.mutate(
      { id, data: { status } },
      {
        onSuccess: () => {
          toast({
            title: status === "fulfilled" ? "Requisition Fulfilled" : "Requisition Cancelled",
            description: `${pilotName ?? "Pilot"}'s request has been ${status}.`,
          });
          queryClient.invalidateQueries({ queryKey: getListAllRedemptionsQueryKey() });
        },
        onError: () => {
          toast({ title: "Error", description: "Failed to update requisition status.", variant: "destructive" });
        }
      }
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Requisition Processing</h1>
        <p className="text-muted-foreground font-mono text-sm">Monitor and fulfill pilot asset requests</p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Global Queue</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !redemptions?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              No requisitions in queue.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">DATE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">PILOT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">ASSET REQUESTED</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">COST</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">STATUS</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">ACTIONS</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {redemptions.map((redemption) => (
                  <TableRow key={redemption.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {format(new Date(redemption.createdAt), "yyyy-MM-dd HH:mm")}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-foreground font-medium">
                      {redemption.userName}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {redemption.rewardName}
                    </TableCell>
                    <TableCell className="font-mono font-bold text-right text-primary">
                      {redemption.papCost}
                    </TableCell>
                    <TableCell className="text-right">
                      <Badge
                        variant={redemption.status === 'fulfilled' ? 'default' : redemption.status === 'cancelled' ? 'destructive' : 'secondary'}
                        className="font-mono text-[10px] rounded-sm"
                      >
                        {redemption.status.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {redemption.status === 'pending' && (
                        <div className="flex gap-2 justify-end">
                          <Button
                            size="sm"
                            className="h-7 rounded-sm font-mono text-[10px] bg-emerald-600 hover:bg-emerald-700"
                            onClick={() => handleUpdateStatus(redemption.id, "fulfilled", redemption.userName)}
                            disabled={updateRedemption.isPending}
                          >
                            <CheckCircle className="w-3 h-3 mr-1" /> FULFILL
                          </Button>
                          <Button
                            size="sm"
                            variant="destructive"
                            className="h-7 rounded-sm font-mono text-[10px]"
                            onClick={() => handleUpdateStatus(redemption.id, "cancelled", redemption.userName)}
                            disabled={updateRedemption.isPending}
                          >
                            <XCircle className="w-3 h-3 mr-1" /> CANCEL
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
    </div>
  );
}
