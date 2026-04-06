import { useListAllPapRecords } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { Loader2 } from "lucide-react";

export function AdminPap() {
  const { data: records, isLoading } = useListAllPapRecords({
    query: {
      queryKey: ["adminPapRecords"]
    }
  });

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-2xl font-bold font-mono tracking-wider text-foreground mb-1 uppercase">Global Ledger</h1>
        <p className="text-muted-foreground font-mono text-sm">Alliance-wide activity point transactions</p>
      </div>

      <Card className="bg-card/40 backdrop-blur border-border/50 rounded-sm">
        <CardHeader className="border-b border-border/30 pb-4">
          <CardTitle className="text-sm font-mono tracking-wider uppercase">Master Record</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 flex justify-center">
              <Loader2 className="w-6 h-6 animate-spin text-primary" />
            </div>
          ) : !records?.length ? (
            <div className="p-8 text-center text-muted-foreground font-mono text-sm">
              No transactions recorded.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="border-border/30 hover:bg-transparent">
                  <TableHead className="font-mono text-xs text-muted-foreground">TIMESTAMP</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">PILOT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">TYPE</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground">CONTEXT</TableHead>
                  <TableHead className="font-mono text-xs text-muted-foreground text-right">DELTA</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {records.map((record) => (
                  <TableRow key={record.id} className="border-border/30 border-b last:border-0 hover:bg-primary/5 transition-colors">
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {format(new Date(record.createdAt), "yyyy-MM-dd HH:mm:ss")}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-foreground font-medium">
                      {record.userName}
                    </TableCell>
                    <TableCell>
                      <Badge variant={record.type === 'fleet' ? 'default' : record.type === 'adjustment' ? 'destructive' : 'secondary'} className="font-mono text-[10px] rounded-sm">
                        {record.type.toUpperCase()}
                      </Badge>
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {record.type === 'fleet' ? record.fleetName : record.reason}
                    </TableCell>
                    <TableCell className={`font-mono font-bold text-right ${record.amount > 0 ? 'text-primary' : 'text-destructive'}`}>
                      {record.amount > 0 ? '+' : ''}{record.amount}
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