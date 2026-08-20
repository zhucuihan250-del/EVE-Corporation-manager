import { useState } from "react";
import { format } from "date-fns";
import { RefreshCw, ShoppingCart, Store } from "lucide-react";
import {
  useCancelPapMarketOrder,
  useCreatePapMarketOrder,
  useGetMe,
  useGetPapMarketOverview,
  useTakePapMarketOrder,
  type PapMarketOrder,
  type PapMarketTransaction,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import i18n from "@/i18n";

const activeOrderStatuses = new Set(["open", "partially_filled"]);

function papValue(value: string): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 1_000_000) / 1_000_000 : 0;
}

function formatPap(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

function formatIsk(amount: number): string {
  return `${formatPap(amount)}e ISK`;
}

function statusLabel(status: string, zh: boolean): string {
  const labels: Record<string, [string, string]> = {
    open: ["开放", "OPEN"],
    partially_filled: ["部分成交", "PARTIALLY FILLED"],
    filled: ["已成交", "FILLED"],
    cancelled: ["已取消", "CANCELLED"],
    expired: ["已过期", "EXPIRED"],
    pending_admin: ["等待审核", "PENDING ADMIN"],
    completed: ["已完成", "COMPLETED"],
    rejected: ["已拒绝", "REJECTED"],
    disputed: ["争议中", "DISPUTED"],
  };
  return labels[status]?.[zh ? 0 : 1] ?? status.toUpperCase();
}

function statusVariant(status: string): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed" || status === "open") return "default";
  if (status === "rejected" || status === "cancelled") return "destructive";
  if (status === "disputed") return "outline";
  return "secondary";
}

export function PapMarket() {
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: me } = useGetMe();
  const overview = useGetPapMarketOverview({ query: { queryKey: ["papMarketOverview"] } });
  const createOrder = useCreatePapMarketOrder();
  const takeOrder = useTakePapMarketOrder();
  const cancelOrder = useCancelPapMarketOrder();
  const [createType, setCreateType] = useState<"buy" | "sell" | null>(null);
  const [createAmount, setCreateAmount] = useState("");
  const [selectedOrder, setSelectedOrder] = useState<PapMarketOrder | null>(null);
  const [takeAmount, setTakeAmount] = useState("");

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["papMarketOverview"] }),
      queryClient.invalidateQueries({ queryKey: ["/api/auth/me"] }),
      queryClient.invalidateQueries({ queryKey: ["dashboardSummary"] }),
    ]);
  };

  const errorToast = (error: unknown) => toast({
    title: tr("操作失败", "Action failed"),
    description: error instanceof Error ? error.message : tr("请稍后重试。", "Please try again."),
    variant: "destructive",
  });

  const submitCreate = () => {
    if (!createType) return;
    const amount = papValue(createAmount);
    if (!amount) return;
    createOrder.mutate({ data: { type: createType, amount, requestId: crypto.randomUUID() } }, {
      onSuccess: async () => {
        setCreateType(null);
        setCreateAmount("");
        await refresh();
        toast({ title: tr("订单已发布", "Order published") });
      },
      onError: errorToast,
    });
  };

  const submitTake = () => {
    if (!selectedOrder) return;
    const amount = papValue(takeAmount);
    if (!amount || amount > selectedOrder.remainingAmount) return;
    takeOrder.mutate({ id: selectedOrder.id, data: { amount, requestId: crypto.randomUUID() } }, {
      onSuccess: async () => {
        setSelectedOrder(null);
        setTakeAmount("");
        await refresh();
        toast({ title: tr("交易已提交审核", "Transaction submitted for review") });
      },
      onError: errorToast,
    });
  };

  const submitCancel = (order: PapMarketOrder) => {
    if (!window.confirm(tr(`确定取消订单 #${order.id} 的未成交部分吗？`, `Cancel the unmatched remainder of order #${order.id}?`))) return;
    cancelOrder.mutate({ id: order.id }, {
      onSuccess: async () => {
        await refresh();
        toast({ title: tr("订单已取消", "Order cancelled") });
      },
      onError: errorToast,
    });
  };

  const marketTable = (orders: PapMarketOrder[], action: "buy" | "sell") => (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader><TableRow>
          <TableHead>{action === "buy" ? tr("卖家", "Seller") : tr("买家", "Buyer")}</TableHead>
          <TableHead className="text-right">{tr("剩余 PAP", "PAP Remaining")}</TableHead>
          <TableHead className="text-right">{tr("交易价值", "Value")}</TableHead>
          <TableHead className="text-right">{tr("操作", "Action")}</TableHead>
        </TableRow></TableHeader>
        <TableBody>
          {orders.length === 0 ? <TableRow><TableCell colSpan={4} className="py-10 text-center text-muted-foreground">{tr("暂无开放订单", "No open orders")}</TableCell></TableRow> : orders.map((order) => {
            const own = order.ownerId === me?.id;
            return <TableRow key={order.id}>
              <TableCell><div className="font-medium">{order.ownerName}</div><div className="text-xs text-muted-foreground">#{order.id}</div></TableCell>
              <TableCell className="text-right font-mono">{formatPap(order.remainingAmount)}</TableCell>
              <TableCell className="text-right font-mono">{formatIsk(order.remainingAmount)}</TableCell>
              <TableCell className="text-right"><Button size="sm" disabled={own} onClick={() => { setSelectedOrder(order); setTakeAmount(String(order.remainingAmount)); }}>
                {own ? tr("我的订单", "My order") : action === "buy" ? tr("购买", "Buy") : tr("出售", "Sell")}
              </Button></TableCell>
            </TableRow>;
          })}
        </TableBody>
      </Table>
    </div>
  );

  const transactionTable = (transactions: PapMarketTransaction[], showCounterparty = true) => (
    <div className="overflow-x-auto"><Table>
      <TableHeader><TableRow>
        <TableHead>{tr("时间", "Time")}</TableHead><TableHead>ID</TableHead><TableHead>{tr("类型", "Type")}</TableHead>
        {showCounterparty && <TableHead>{tr("交易对象", "Counterparty")}</TableHead>}
        <TableHead className="text-right">PAP</TableHead><TableHead className="text-right">ISK</TableHead><TableHead>{tr("状态", "Status")}</TableHead>
      </TableRow></TableHeader>
      <TableBody>{transactions.length === 0 ? <TableRow><TableCell colSpan={showCounterparty ? 7 : 6} className="py-10 text-center text-muted-foreground">{tr("暂无交易", "No transactions")}</TableCell></TableRow> : transactions.map((transaction) => {
        const isBuyer = transaction.buyerId === me?.id;
        return <TableRow key={transaction.id}>
          <TableCell className="text-xs text-muted-foreground">{format(new Date(transaction.createdAt), "yyyy-MM-dd HH:mm")}</TableCell>
          <TableCell className="font-mono">#{transaction.id}</TableCell>
          <TableCell>{showCounterparty ? (isBuyer ? tr("购买", "BUY") : tr("出售", "SELL")) : transaction.orderType === "sell" ? tr("卖单成交", "SELL ORDER") : tr("买单成交", "BUY ORDER")}</TableCell>
          {showCounterparty && <TableCell>{isBuyer ? transaction.sellerName : transaction.buyerName}</TableCell>}
          <TableCell className="text-right font-mono">{formatPap(transaction.papAmount)}</TableCell>
          <TableCell className="text-right font-mono">{formatIsk(transaction.papAmount)}</TableCell>
          <TableCell><Badge variant={statusVariant(transaction.status)}>{statusLabel(transaction.status, zh)}</Badge></TableCell>
        </TableRow>;
      })}</TableBody>
    </Table></div>
  );

  const data = overview.data;
  const currentAvailablePap = data?.wallet.availablePap ?? me?.availablePap ?? 0;
  return <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 className="text-2xl font-bold font-mono tracking-wider">PAP MARKET</h1><p className="text-sm text-muted-foreground">{tr("玩家 PAP 订单与交易", "Player PAP orders and transactions")}</p></div>
      <Button variant="outline" size="sm" onClick={() => overview.refetch()} disabled={overview.isFetching}><RefreshCw className={`mr-2 h-4 w-4 ${overview.isFetching ? "animate-spin" : ""}`} />{tr("刷新", "Refresh")}</Button>
    </div>

    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {[
        [tr("我的 PAP", "My PAP"), data?.wallet.totalPap ?? me?.totalPap ?? 0],
        [tr("可用 PAP", "Available PAP"), data?.wallet.availablePap ?? me?.availablePap ?? 0],
        [tr("冻结 PAP", "Locked PAP"), data?.wallet.lockedPap ?? me?.lockedPap ?? 0],
      ].map(([label, value], index) => <Card key={String(label)} className={index === 1 ? "border-primary/30 bg-primary/5" : "bg-card/40"}><CardHeader className="pb-2"><CardTitle className="text-xs text-muted-foreground">{label}</CardTitle></CardHeader><CardContent><div className="text-3xl font-bold font-mono">{formatPap(Number(value))}</div></CardContent></Card>)}
    </div>

    <div className="flex flex-wrap gap-3">
      <Button onClick={() => { setCreateType("buy"); setCreateAmount(""); }}><ShoppingCart className="mr-2 h-4 w-4" />{tr("发布买单", "Post BUY order")}</Button>
      <Button variant="secondary" onClick={() => { setCreateType("sell"); setCreateAmount(""); }}><Store className="mr-2 h-4 w-4" />{tr("发布卖单", "Post SELL order")}</Button>
    </div>

    <Card className="bg-card/30"><CardContent className="pt-6"><Tabs defaultValue="buy">
      <TabsList className="grid w-full grid-cols-6">
        <TabsTrigger value="buy">{tr("购买 PAP", "Buy PAP")}</TabsTrigger><TabsTrigger value="sell">{tr("出售 PAP", "Sell PAP")}</TabsTrigger>
        <TabsTrigger value="orders">{tr("我的订单", "My orders")}</TabsTrigger><TabsTrigger value="transactions">{tr("我的交易", "My trades")}</TabsTrigger><TabsTrigger value="ledger">{tr("PAP 流水", "PAP ledger")}</TabsTrigger><TabsTrigger value="history">{tr("交易历史", "History")}</TabsTrigger>
      </TabsList>
      <TabsContent value="buy" className="mt-4">{marketTable(data?.sellOrders ?? [], "buy")}</TabsContent>
      <TabsContent value="sell" className="mt-4">{marketTable(data?.buyOrders ?? [], "sell")}</TabsContent>
      <TabsContent value="orders" className="mt-4"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>ID</TableHead><TableHead>{tr("类型", "Type")}</TableHead><TableHead className="text-right">{tr("原始", "Original")}</TableHead><TableHead className="text-right">{tr("剩余", "Remaining")}</TableHead><TableHead>{tr("状态", "Status")}</TableHead><TableHead className="text-right">{tr("操作", "Action")}</TableHead></TableRow></TableHeader><TableBody>{(data?.myOrders ?? []).map(order => <TableRow key={order.id}><TableCell>#{order.id}</TableCell><TableCell>{order.type.toUpperCase()}</TableCell><TableCell className="text-right font-mono">{formatPap(order.originalAmount)}</TableCell><TableCell className="text-right font-mono">{formatPap(order.remainingAmount)}</TableCell><TableCell><Badge variant={statusVariant(order.status)}>{statusLabel(order.status, zh)}</Badge></TableCell><TableCell className="text-right"><Button size="sm" variant="outline" disabled={!activeOrderStatuses.has(order.status)} onClick={() => submitCancel(order)}>{tr("取消", "Cancel")}</Button></TableCell></TableRow>)}</TableBody></Table></div></TabsContent>
      <TabsContent value="transactions" className="mt-4">{transactionTable(data?.myTransactions ?? [])}</TabsContent>
      <TabsContent value="ledger" className="mt-4"><div className="overflow-x-auto"><Table><TableHeader><TableRow><TableHead>{tr("时间", "Time")}</TableHead><TableHead>{tr("类型", "Type")}</TableHead><TableHead>{tr("关联", "Reference")}</TableHead><TableHead className="text-right">{tr("余额变动", "Balance delta")}</TableHead><TableHead className="text-right">{tr("冻结变动", "Lock delta")}</TableHead><TableHead className="text-right">{tr("可用余额", "Available")}</TableHead></TableRow></TableHeader><TableBody>{(data?.ledger ?? []).map(entry => <TableRow key={entry.id}><TableCell className="text-xs text-muted-foreground">{format(new Date(entry.createdAt), "yyyy-MM-dd HH:mm")}</TableCell><TableCell><Badge variant="secondary">{entry.type.toUpperCase()}</Badge></TableCell><TableCell className="font-mono text-xs">{entry.transactionId ? `TX #${entry.transactionId}` : entry.orderId ? `ORDER #${entry.orderId}` : "—"}</TableCell><TableCell className={`text-right font-mono ${entry.amount < 0 ? "text-destructive" : entry.amount > 0 ? "text-primary" : ""}`}>{entry.amount > 0 ? "+" : ""}{formatPap(entry.amount)}</TableCell><TableCell className="text-right font-mono">{entry.lockedDelta > 0 ? "+" : ""}{formatPap(entry.lockedDelta)}</TableCell><TableCell className="text-right font-mono">{formatPap(entry.availableAfter)}</TableCell></TableRow>)}</TableBody></Table></div></TabsContent>
      <TabsContent value="history" className="mt-4">{transactionTable(data?.history ?? [], false)}</TabsContent>
    </Tabs></CardContent></Card>

    <Dialog open={createType !== null} onOpenChange={(open) => !open && setCreateType(null)}><DialogContent><DialogHeader><DialogTitle>{createType === "buy" ? tr("发布买单", "Post BUY order") : tr("发布卖单", "Post SELL order")}</DialogTitle><DialogDescription>{tr("输入 PAP 数量并确认订单。", "Enter the PAP amount and confirm the order.")}</DialogDescription></DialogHeader><div className="space-y-4"><div className="space-y-2"><Label>{tr("PAP 数量", "PAP amount")}</Label><Input type="number" min="0.000001" max="1000000" step="1" value={createAmount} onChange={event => setCreateAmount(event.target.value)} autoFocus /></div><div className="rounded-md border bg-muted/30 p-4"><div className="text-xs text-muted-foreground">{tr("交易总价值", "Total value")}</div><div className="mt-1 text-xl font-bold font-mono">{formatIsk(papValue(createAmount))}</div></div><p className="text-sm">{createType === "buy" ? tr(`确定要购买 ${formatPap(papValue(createAmount))} PAP 吗？`, `Buy ${formatPap(papValue(createAmount))} PAP?`) : tr(`确定要出售 ${formatPap(papValue(createAmount))} PAP 吗？`, `Sell ${formatPap(papValue(createAmount))} PAP?`)}</p></div><DialogFooter><Button variant="outline" onClick={() => setCreateType(null)}>{tr("取消", "Cancel")}</Button><Button disabled={!papValue(createAmount) || (createType === "sell" && papValue(createAmount) > currentAvailablePap) || createOrder.isPending} onClick={submitCreate}>{tr("确认", "Confirm")}</Button></DialogFooter></DialogContent></Dialog>

    <Dialog open={selectedOrder !== null} onOpenChange={(open) => !open && setSelectedOrder(null)}><DialogContent><DialogHeader><DialogTitle>{selectedOrder?.type === "sell" ? tr("购买 PAP", "Buy PAP") : tr("出售 PAP", "Sell PAP")}</DialogTitle><DialogDescription>{tr("可部分接单，提交后交易将等待管理员审核。", "Partial fills are supported. The transaction will await admin review.")}</DialogDescription></DialogHeader><div className="space-y-4"><div className="space-y-2"><Label>{tr("接单数量", "Amount")}</Label><Input type="number" min="0.000001" max={selectedOrder?.remainingAmount} step="1" value={takeAmount} onChange={event => setTakeAmount(event.target.value)} autoFocus /></div><div className="rounded-md border bg-muted/30 p-4"><div className="text-xs text-muted-foreground">{tr("交易总价值", "Total value")}</div><div className="mt-1 text-xl font-bold font-mono">{formatIsk(papValue(takeAmount))}</div></div><p className="text-sm">{selectedOrder?.type === "sell" ? tr(`确定要购买 ${formatPap(papValue(takeAmount))} PAP 吗？`, `Buy ${formatPap(papValue(takeAmount))} PAP?`) : tr(`确定要出售 ${formatPap(papValue(takeAmount))} PAP 吗？`, `Sell ${formatPap(papValue(takeAmount))} PAP?`)}</p></div><DialogFooter><Button variant="outline" onClick={() => setSelectedOrder(null)}>{tr("取消", "Cancel")}</Button><Button disabled={!papValue(takeAmount) || papValue(takeAmount) > (selectedOrder?.remainingAmount ?? 0) || (selectedOrder?.type === "buy" && papValue(takeAmount) > currentAvailablePap) || takeOrder.isPending} onClick={submitTake}>{selectedOrder?.type === "sell" ? tr("确认购买", "Confirm purchase") : tr("确认出售", "Confirm sale")}</Button></DialogFooter></DialogContent></Dialog>
  </div>;
}
