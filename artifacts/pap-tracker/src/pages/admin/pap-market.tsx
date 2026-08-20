import { useState } from "react";
import { format } from "date-fns";
import { AlertTriangle, Check, RefreshCw, ShieldAlert, X } from "lucide-react";
import {
  useGetPapMarketAdminOverview,
  useReviewPapMarketTransaction,
  type PapMarketOrder,
  type PapMarketTransaction,
  type ReviewPapMarketTransactionBodyAction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import i18n from "@/i18n";

function pap(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function statusText(status: string, zh: boolean): string {
  const values: Record<string, [string, string]> = {
    open: ["开放", "OPEN"], partially_filled: ["部分成交", "PARTIALLY FILLED"], filled: ["已成交", "FILLED"],
    cancelled: ["已取消", "CANCELLED"], expired: ["已过期", "EXPIRED"], pending_admin: ["待审核", "PENDING"],
    completed: ["已完成", "COMPLETED"], rejected: ["已拒绝", "REJECTED"], disputed: ["争议", "DISPUTED"],
  };
  return values[status]?.[zh ? 0 : 1] ?? status;
}

function badgeVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed" || status === "open") return "default";
  if (status === "rejected" || status === "cancelled") return "destructive";
  if (status === "disputed") return "outline";
  return "secondary";
}

export function AdminPapMarket() {
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const overview = useGetPapMarketAdminOverview({ query: { queryKey: ["papMarketAdminOverview"] } });
  const review = useReviewPapMarketTransaction();
  const [selected, setSelected] = useState<PapMarketTransaction | null>(null);
  const [action, setAction] = useState<ReviewPapMarketTransactionBodyAction | null>(null);
  const [note, setNote] = useState("");

  const openReview = (transaction: PapMarketTransaction, nextAction: ReviewPapMarketTransactionBodyAction) => {
    setSelected(transaction);
    setAction(nextAction);
    setNote("");
  };

  const submitReview = () => {
    if (!selected || !action) return;
    review.mutate({ id: selected.id, data: { action, note } }, {
      onSuccess: async () => {
        setSelected(null);
        setAction(null);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["papMarketAdminOverview"] }),
          queryClient.invalidateQueries({ queryKey: ["papMarketOverview"] }),
          queryClient.invalidateQueries({ queryKey: ["adminPapRecords"] }),
        ]);
        toast({ title: tr("审核操作已记录", "Review action recorded") });
      },
      onError: (error) => toast({ title: tr("审核失败", "Review failed"), description: error instanceof Error ? error.message : tr("请稍后重试。", "Please try again."), variant: "destructive" }),
    });
  };

  const transactionTable = (transactions: PapMarketTransaction[], actions = false) => <div className="overflow-x-auto"><Table>
    <TableHeader><TableRow><TableHead>ID</TableHead><TableHead>{tr("创建时间", "Created")}</TableHead><TableHead>{tr("买家", "Buyer")}</TableHead><TableHead>{tr("卖家", "Seller")}</TableHead><TableHead className="text-right">PAP</TableHead><TableHead className="text-right">ISK</TableHead><TableHead>{tr("订单", "Order")}</TableHead><TableHead>{tr("状态", "Status")}</TableHead>{actions && <TableHead className="text-right">{tr("审核", "Review")}</TableHead>}</TableRow></TableHeader>
    <TableBody>{transactions.length === 0 ? <TableRow><TableCell colSpan={actions ? 9 : 8} className="py-10 text-center text-muted-foreground">{tr("暂无交易", "No transactions")}</TableCell></TableRow> : transactions.map(transaction => <TableRow key={transaction.id}>
      <TableCell className="font-mono">#{transaction.id}</TableCell><TableCell className="text-xs text-muted-foreground">{format(new Date(transaction.createdAt), "yyyy-MM-dd HH:mm")}</TableCell><TableCell>{transaction.buyerName}</TableCell><TableCell>{transaction.sellerName}</TableCell><TableCell className="text-right font-mono">{pap(transaction.papAmount)}</TableCell><TableCell className="text-right font-mono">{pap(transaction.papAmount)}e</TableCell><TableCell className="font-mono">#{transaction.orderId}</TableCell><TableCell><Badge variant={badgeVariant(transaction.status)}>{statusText(transaction.status, zh)}</Badge></TableCell>{actions && <TableCell className="text-right"><div className="flex justify-end gap-1"><Button size="icon" variant="ghost" title={tr("批准", "Approve")} onClick={() => openReview(transaction, "approve")}><Check className="h-4 w-4 text-emerald-400" /></Button><Button size="icon" variant="ghost" title={tr("拒绝", "Reject")} onClick={() => openReview(transaction, "reject")}><X className="h-4 w-4 text-destructive" /></Button><Button size="icon" variant="ghost" title={tr("标记争议", "Dispute")} onClick={() => openReview(transaction, "dispute")}><AlertTriangle className="h-4 w-4 text-amber-400" /></Button></div></TableCell>}</TableRow>)}</TableBody>
  </Table></div>;

  const orderTable = (orders: PapMarketOrder[]) => <div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>ID</TableHead><TableHead>{tr("所有者", "Owner")}</TableHead><TableHead>{tr("类型", "Type")}</TableHead><TableHead className="text-right">{tr("原始", "Original")}</TableHead><TableHead className="text-right">{tr("已匹配", "Matched")}</TableHead><TableHead className="text-right">{tr("剩余", "Remaining")}</TableHead><TableHead className="text-right">{tr("冻结", "Locked")}</TableHead><TableHead>{tr("状态", "Status")}</TableHead></TableRow></TableHeader><TableBody>{orders.length === 0 ? <TableRow><TableCell colSpan={8} className="py-10 text-center text-muted-foreground">{tr("暂无订单", "No orders")}</TableCell></TableRow> : orders.map(order => <TableRow key={order.id}><TableCell>#{order.id}</TableCell><TableCell>{order.ownerName}</TableCell><TableCell>{order.type.toUpperCase()}</TableCell><TableCell className="text-right font-mono">{pap(order.originalAmount)}</TableCell><TableCell className="text-right font-mono">{pap(order.matchedAmount)}</TableCell><TableCell className="text-right font-mono">{pap(order.remainingAmount)}</TableCell><TableCell className="text-right font-mono">{pap(order.lockedPapAmount)}</TableCell><TableCell><Badge variant={badgeVariant(order.status)}>{statusText(order.status, zh)}</Badge></TableCell></TableRow>)}</TableBody></Table></div>;

  const transactions = overview.data?.transactions ?? [];
  const pending = transactions.filter(item => item.status === "pending_admin");
  const disputed = transactions.filter(item => item.status === "disputed");
  const history = transactions.filter(item => !["pending_admin", "disputed"].includes(item.status));
  const orders = overview.data?.orders ?? [];

  return <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider"><ShieldAlert className="h-6 w-6 text-primary" />PAP MARKET MANAGEMENT</h1><p className="text-sm text-muted-foreground">{tr("审核 PAP 交易、订单与管理员审计记录", "Review PAP transactions, orders, and admin audit history")}</p></div><Button variant="outline" size="sm" onClick={() => overview.refetch()} disabled={overview.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${overview.isFetching ? "animate-spin" : ""}`} />{tr("刷新", "Refresh")}</Button></div>
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3"><Card className="border-amber-500/30 bg-amber-500/5"><CardContent className="pt-6"><div className="text-xs text-muted-foreground">{tr("待审核交易", "Pending")}</div><div className="mt-1 text-3xl font-bold font-mono">{pending.length}</div></CardContent></Card><Card className="border-destructive/30 bg-destructive/5"><CardContent className="pt-6"><div className="text-xs text-muted-foreground">{tr("争议交易", "Disputed")}</div><div className="mt-1 text-3xl font-bold font-mono">{disputed.length}</div></CardContent></Card><Card><CardContent className="pt-6"><div className="text-xs text-muted-foreground">{tr("当前开放订单", "Open orders")}</div><div className="mt-1 text-3xl font-bold font-mono">{orders.filter(order => ["open", "partially_filled"].includes(order.status)).length}</div></CardContent></Card></div>
    <Card><CardContent className="pt-6"><Tabs defaultValue="pending"><TabsList className="grid w-full grid-cols-6"><TabsTrigger value="pending">{tr("待审核", "Pending")}</TabsTrigger><TabsTrigger value="disputed">{tr("争议", "Disputed")}</TabsTrigger><TabsTrigger value="history">{tr("历史", "History")}</TabsTrigger><TabsTrigger value="buy">{tr("买单", "BUY Orders")}</TabsTrigger><TabsTrigger value="sell">{tr("卖单", "SELL Orders")}</TabsTrigger><TabsTrigger value="logs">{tr("审计与流水", "Audit & Ledger")}</TabsTrigger></TabsList><TabsContent value="pending" className="mt-4">{transactionTable(pending, true)}</TabsContent><TabsContent value="disputed" className="mt-4">{transactionTable(disputed, true)}</TabsContent><TabsContent value="history" className="mt-4">{transactionTable(history)}</TabsContent><TabsContent value="buy" className="mt-4">{orderTable(orders.filter(order => order.type === "buy"))}</TabsContent><TabsContent value="sell" className="mt-4">{orderTable(orders.filter(order => order.type === "sell"))}</TabsContent><TabsContent value="logs" className="mt-4 space-y-6"><div><h3 className="mb-3 text-sm font-semibold">{tr("管理员操作日志", "Admin action log")}</h3><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{tr("时间", "Time")}</TableHead><TableHead>{tr("管理员", "Admin")}</TableHead><TableHead>{tr("操作", "Action")}</TableHead><TableHead>{tr("交易", "Transaction")}</TableHead><TableHead>{tr("订单", "Order")}</TableHead><TableHead>{tr("备注", "Note")}</TableHead></TableRow></TableHeader><TableBody>{(overview.data?.adminLogs ?? []).map(log => <TableRow key={log.id}><TableCell className="text-xs">{format(new Date(log.createdAt), "yyyy-MM-dd HH:mm")}</TableCell><TableCell>#{log.adminId}</TableCell><TableCell><Badge>{log.action.toUpperCase()}</Badge></TableCell><TableCell>#{log.transactionId}</TableCell><TableCell>#{log.orderId}</TableCell><TableCell className="max-w-xs truncate">{log.note || "—"}</TableCell></TableRow>)}</TableBody></Table></div></div><div><h3 className="mb-3 text-sm font-semibold">{tr("PAP 余额与冻结流水", "PAP balance and lock ledger")}</h3><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{tr("时间", "Time")}</TableHead><TableHead>{tr("成员", "Member")}</TableHead><TableHead>{tr("类型", "Type")}</TableHead><TableHead>{tr("关联", "Reference")}</TableHead><TableHead className="text-right">{tr("余额变动", "Balance delta")}</TableHead><TableHead className="text-right">{tr("冻结变动", "Lock delta")}</TableHead><TableHead className="text-right">{tr("可用", "Available")}</TableHead></TableRow></TableHeader><TableBody>{(overview.data?.ledger ?? []).map(entry => <TableRow key={entry.id}><TableCell className="text-xs">{format(new Date(entry.createdAt), "yyyy-MM-dd HH:mm")}</TableCell><TableCell>{entry.userName}</TableCell><TableCell><Badge variant="secondary">{entry.type.toUpperCase()}</Badge></TableCell><TableCell className="font-mono text-xs">{entry.transactionId ? `TX #${entry.transactionId}` : entry.orderId ? `ORDER #${entry.orderId}` : "—"}</TableCell><TableCell className="text-right font-mono">{entry.amount > 0 ? "+" : ""}{pap(entry.amount)}</TableCell><TableCell className="text-right font-mono">{entry.lockedDelta > 0 ? "+" : ""}{pap(entry.lockedDelta)}</TableCell><TableCell className="text-right font-mono">{pap(entry.availableAfter)}</TableCell></TableRow>)}</TableBody></Table></div></div></TabsContent></Tabs></CardContent></Card>
    <Dialog open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}><DialogContent><DialogHeader><DialogTitle>{action === "approve" ? tr("批准交易", "Approve transaction") : action === "reject" ? tr("拒绝交易", "Reject transaction") : tr("标记争议", "Mark disputed")}</DialogTitle><DialogDescription>{tr(`交易 #${selected?.id ?? ""} · ${pap(selected?.papAmount ?? 0)} PAP · ${pap(selected?.papAmount ?? 0)}e ISK`, `Transaction #${selected?.id ?? ""} · ${pap(selected?.papAmount ?? 0)} PAP · ${pap(selected?.papAmount ?? 0)}e ISK`)}</DialogDescription></DialogHeader><div className="space-y-2"><Label>{tr("审核备注", "Review note")}{action !== "approve" ? " *" : ""}</Label><Textarea value={note} onChange={event => setNote(event.target.value)} maxLength={2000} placeholder={tr("记录审核依据", "Record the review rationale")} /></div><DialogFooter><Button variant="outline" onClick={() => setSelected(null)}>{tr("取消", "Cancel")}</Button><Button variant={action === "reject" ? "destructive" : "default"} disabled={review.isPending || (action !== "approve" && !note.trim())} onClick={submitReview}>{tr("确认", "Confirm")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
