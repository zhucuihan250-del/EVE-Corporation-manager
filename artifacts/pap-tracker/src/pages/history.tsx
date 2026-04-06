import { useListPapRecords } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";

export function History() {
  const { data: records, isLoading } = useListPapRecords({
    query: {
      queryKey: ["papRecords"]
    }
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Participation History</h1>
        <p className="text-muted-foreground font-mono text-sm">Chronological record of earned Activity Points</p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">PAP Ledger</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !records?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              No participation records found.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">DATE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">TYPE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">DETAILS</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">AMOUNT</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-sm">
                      {format(new Date(record.createdAt), "yyyy-MM-dd HH:mm")}
                    </TableCell>
                    <TableCell>
                      <Badge variant={record.type === 'fleet' ? 'default' : 'secondary'} className="font-mono text-[10px] rounded-sm">
                        {record.type.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {record.type === 'fleet' ? record.fleetName : record.reason}
                    </TableCell>
                    <TableCell className="font-mono font-bold text-right text-primary">
                      +{record.amount}
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