import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListCourierOrdersQueryKey,
  getGetMyCourierProfileQueryKey,
  getListCourierRoutesQueryKey,
  useCreateMyCourierRoute,
  useCreateCourierOrder,
  useGetMyCourierProfile,
  useGetMe,
  useListCourierOrders,
  useListCourierRoutes,
  useQuoteCourierOrder,
  useUpdateCourierOrder,
  useUpdateMyCourierRoute,
  type CourierOrder,
  type CourierPricingMethod,
  type CourierRoute,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { Calculator, MapPin, Package, Send, Truck } from "lucide-react";
import { useTranslation } from "react-i18next";

const formatIsk = (value: number) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value)} ISK`;
const formatVolume = (value: number) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 }).format(value)} m³`;
type MyRouteDraft = { id: number | null; origin: string; destination: string; pricingMethod: CourierPricingMethod; baseFee: string; pricePerM3: string; collateralRate: string; isActive: boolean };
const emptyMyRoute = (): MyRouteDraft => ({ id: null, origin: "", destination: "", pricingMethod: "fixed", baseFee: "", pricePerM3: "0", collateralRate: "0", isActive: true });

export function Courier() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: user } = useGetMe();
  const routes = useListCourierRoutes();
  const orders = useListCourierOrders();
  const quote = useQuoteCourierOrder();
  const create = useCreateCourierOrder();
  const update = useUpdateCourierOrder();
  const profile = useGetMyCourierProfile();
  const createMyRoute = useCreateMyCourierRoute();
  const updateMyRoute = useUpdateMyCourierRoute();
  const [form, setForm] = useState({ routeId: "", volumeM3: "", collateral: "", note: "" });
  const [quoteResult, setQuoteResult] = useState<Awaited<ReturnType<typeof quote.mutateAsync>> | null>(null);
  const [internalNotes, setInternalNotes] = useState<Record<number, string>>({});
  const [myRoute, setMyRoute] = useState<MyRouteDraft>(emptyMyRoute());

  const selectedRoute = useMemo(
    () => (routes.data ?? []).find((route) => route.id === Number(form.routeId)),
    [form.routeId, routes.data],
  );
  const refreshOrders = () => queryClient.invalidateQueries({ queryKey: getListCourierOrdersQueryKey() });
  const refreshCourierRoutes = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: getGetMyCourierProfileQueryKey() }),
    queryClient.invalidateQueries({ queryKey: getListCourierRoutesQueryKey() }),
  ]);
  const changeForm = (next: typeof form) => { setForm(next); setQuoteResult(null); };
  const validInput = Number(form.routeId) > 0 && Number(form.volumeM3) > 0 && Number(form.collateral) >= 0 && form.collateral !== "";

  const pricingLabels: Record<string, string> = {
    fixed: tr("固定价格", "Fixed fee"),
    volume: tr("基础费 + 按体积", "Base + volume"),
    collateral: tr("基础费 + 保证金比例", "Base + collateral rate"),
    volume_collateral: tr("基础费 + 体积 + 保证金比例", "Base + volume + collateral rate"),
  };
  const statusLabels: Record<string, string> = {
    submitted: tr("待接单", "Submitted"), accepted: tr("已接单", "Accepted"), in_transit: tr("运输中", "In transit"),
    completed: tr("已完成", "Completed"), rejected: tr("已拒绝", "Rejected"), cancelled: tr("已取消", "Cancelled"),
  };

  const calculate = () => {
    if (!validInput) return;
    quote.mutate({ data: { routeId: Number(form.routeId), volumeM3: Number(form.volumeM3), collateral: Number(form.collateral) } }, {
      onSuccess: setQuoteResult,
      onError: (error) => toast({ title: tr("计算失败", "Quote failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const submit = () => {
    if (!quoteResult || !validInput) return;
    create.mutate({ data: { routeId: Number(form.routeId), volumeM3: Number(form.volumeM3), collateral: Number(form.collateral), quotedFee: quoteResult.calculatedFee, note: form.note } }, {
      onSuccess: async () => {
        setForm({ routeId: "", volumeM3: "", collateral: "", note: "" });
        setQuoteResult(null);
        await refreshOrders();
        toast({ title: tr("快递委托已提交", "Courier order submitted") });
      },
      onError: (error) => toast({ title: tr("提交失败", "Submission failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const advance = (order: CourierOrder, status: "accepted" | "in_transit" | "completed" | "rejected" | "cancelled") => {
    update.mutate({ id: order.id, data: { status, internalNotes: internalNotes[order.id] ?? order.internalNotes ?? "" } }, {
      onSuccess: refreshOrders,
      onError: (error) => toast({ title: tr("更新失败", "Update failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const loadMyRoute = (item: CourierRoute) => setMyRoute({ id: item.id, origin: item.origin, destination: item.destination, pricingMethod: item.pricingMethod, baseFee: String(item.baseFee), pricePerM3: String(item.pricePerM3), collateralRate: String(item.collateralRate), isActive: item.isActive });
  const saveMyRoute = () => {
    const data = { origin: myRoute.origin, destination: myRoute.destination, pricingMethod: myRoute.pricingMethod, baseFee: Number(myRoute.baseFee || 0), pricePerM3: Number(myRoute.pricePerM3 || 0), collateralRate: Number(myRoute.collateralRate || 0), isActive: myRoute.isActive };
    const options = { onSuccess: async () => { setMyRoute(emptyMyRoute()); await refreshCourierRoutes(); toast({ title: tr("我的快递线路已保存", "Your courier route was saved") }); }, onError: (error: unknown) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" as const }) };
    if (myRoute.id === null) createMyRoute.mutate({ data }, options);
    else updateMyRoute.mutate({ id: myRoute.id, data }, options);
  };

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div><h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider"><Truck className="h-6 w-6 text-primary" />{tr("军团快递", "CORPORATION COURIER")}</h1><p className="mt-1 text-sm text-muted-foreground">{tr("选择快递员提供的既定线路，填写体积和保证金，系统按该线路规则计算快递费。", "Choose a courier's configured route, enter volume and collateral, and receive an authoritative price.")}</p></div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Package className="h-5 w-5" />{tr("新建快递委托", "New courier order")}</CardTitle><CardDescription>{tr(`实名提交人：${user?.eveCharacterName ?? "-"}`, `Named submitter: ${user?.eveCharacterName ?? "-"}`)}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2"><Label>{tr("快递线路", "Courier route")}</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3" value={form.routeId} onChange={(event) => changeForm({ ...form, routeId: event.target.value })}><option value="">{tr("请选择起点、终点和快递员", "Select origin, destination, and courier")}</option>{(routes.data ?? []).map((route) => <option key={route.id} value={route.id}>{route.origin} → {route.destination} · {route.courierName}</option>)}</select></div>
          {selectedRoute && <div className="md:col-span-2 rounded-md border border-border/50 bg-muted/20 p-4 text-sm"><div className="flex items-center gap-2 font-medium"><MapPin className="h-4 w-4 text-primary" />{selectedRoute.origin} → {selectedRoute.destination}</div><div className="mt-2 text-muted-foreground">{tr("快递员", "Courier")}: {selectedRoute.courierName} · {pricingLabels[selectedRoute.pricingMethod]}</div><div className="mt-1 text-xs text-muted-foreground">{tr("基础费", "Base")}: {formatIsk(selectedRoute.baseFee)} · {tr("每 m³", "Per m³")}: {formatIsk(selectedRoute.pricePerM3)} · {tr("保证金费率", "Collateral rate")}: {selectedRoute.collateralRate}%</div></div>}
          <div className="space-y-2"><Label>{tr("快递体积（m³）", "Volume (m³)")}</Label><Input type="number" min="0.01" step="0.01" value={form.volumeM3} onChange={(event) => changeForm({ ...form, volumeM3: event.target.value })} placeholder="例如 60000" /></div>
          <div className="space-y-2"><Label>{tr("所需保证金（ISK）", "Collateral (ISK)")}</Label><Input type="number" min="0" step="1" value={form.collateral} onChange={(event) => changeForm({ ...form, collateral: event.target.value })} placeholder="例如 1000000000" /></div>
          <div className="space-y-2 md:col-span-2"><Label>{tr("货物说明或合同备注（可选）", "Cargo or contract note (optional)")}</Label><Textarea rows={3} value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} /></div>
          <Button variant="outline" disabled={!validInput || quote.isPending} onClick={calculate}><Calculator className="mr-2 h-4 w-4" />{tr("计算快递费", "Calculate fee")}</Button>
          <Button disabled={!quoteResult || create.isPending} onClick={submit}><Send className="mr-2 h-4 w-4" />{tr("确认价格并提交", "Confirm and submit")}</Button>
          {quoteResult && <div className="md:col-span-2 rounded-md border border-primary/40 bg-primary/10 p-5"><div className="text-sm text-muted-foreground">{quoteResult.origin} → {quoteResult.destination} · {quoteResult.courierName}</div><div className="mt-1 text-2xl font-bold text-primary">{formatIsk(quoteResult.calculatedFee)}</div><div className="mt-2 text-xs text-muted-foreground">{formatVolume(quoteResult.volumeM3)} · {tr("保证金", "Collateral")} {formatIsk(quoteResult.collateral)} · {quoteResult.formula}</div></div>}
        </CardContent>
      </Card>

      {profile.data?.isCourier && <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><Truck className="h-5 w-5 text-primary" />{tr("我的快递员线路设置", "My courier route settings")}</CardTitle><CardDescription>{tr("管理员已将您登记为快递员。您只能维护自己名下的线路和价格。", "You are a registered courier and may maintain only your own routes and prices.")}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><Label>{tr("起点", "Origin")}</Label><Input value={myRoute.origin} onChange={(event) => setMyRoute({ ...myRoute, origin: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("终点", "Destination")}</Label><Input value={myRoute.destination} onChange={(event) => setMyRoute({ ...myRoute, destination: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("计算方法", "Pricing method")}</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3" value={myRoute.pricingMethod} onChange={(event) => setMyRoute({ ...myRoute, pricingMethod: event.target.value as CourierPricingMethod })}>{Object.entries(pricingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="space-y-2"><Label>{tr("基础／固定快递费（ISK）", "Base or fixed fee (ISK)")}</Label><Input type="number" min="0" value={myRoute.baseFee} onChange={(event) => setMyRoute({ ...myRoute, baseFee: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("每 m³ 快递费（ISK）", "Fee per m³ (ISK)")}</Label><Input type="number" min="0" disabled={!['volume', 'volume_collateral'].includes(myRoute.pricingMethod)} value={myRoute.pricePerM3} onChange={(event) => setMyRoute({ ...myRoute, pricePerM3: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("保证金费率（%）", "Collateral rate (%)")}</Label><Input type="number" min="0" max="100" step="0.01" disabled={!['collateral', 'volume_collateral'].includes(myRoute.pricingMethod)} value={myRoute.collateralRate} onChange={(event) => setMyRoute({ ...myRoute, collateralRate: event.target.value })} /></div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={myRoute.isActive} onChange={(event) => setMyRoute({ ...myRoute, isActive: event.target.checked })} />{tr("线路启用", "Route active")}</label>
          <div className="flex gap-2"><Button className="flex-1" disabled={!myRoute.origin.trim() || !myRoute.destination.trim() || createMyRoute.isPending || updateMyRoute.isPending} onClick={saveMyRoute}>{tr("保存我的线路", "Save my route")}</Button>{myRoute.id && <Button variant="outline" onClick={() => setMyRoute(emptyMyRoute())}>{tr("取消编辑", "Cancel")}</Button>}</div>
          <div className="space-y-2 md:col-span-2">{(profile.data.routes ?? []).map((item) => <div key={item.id} className="flex flex-col gap-2 rounded-md border border-border/50 p-3 sm:flex-row sm:items-center"><div className="flex-1"><div className="text-sm font-medium">{item.origin} → {item.destination}</div><div className="text-xs text-muted-foreground">{pricingLabels[item.pricingMethod]} · {formatIsk(item.baseFee)} · {formatIsk(item.pricePerM3)}/m³ · {item.collateralRate}%</div></div><Badge variant={item.isActive ? "default" : "secondary"}>{item.isActive ? tr("启用", "Active") : tr("停用", "Inactive")}</Badge><Button size="sm" variant="outline" onClick={() => loadMyRoute(item)}>{tr("编辑", "Edit")}</Button></div>)}</div>
        </CardContent>
      </Card>}

      <Card>
        <CardHeader><CardTitle>{tr("我的快递与待处理委托", "My and assigned orders")}</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {(orders.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无快递委托", "No courier orders")}</p> : (orders.data ?? []).map((order) => (
            <div key={order.id} className="space-y-3 rounded-md border border-border/50 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-medium">#{order.id} · {order.origin} → {order.destination}</div><div className="mt-1 text-xs text-muted-foreground">{order.submitterName} · {tr("快递员", "Courier")} {order.courierName} · {new Date(order.createdAt).toLocaleString()}</div></div><Badge variant={order.status === "rejected" || order.status === "cancelled" ? "destructive" : order.status === "completed" ? "secondary" : "default"}>{statusLabels[order.status]}</Badge></div>
              <div className="grid gap-2 text-sm sm:grid-cols-3"><div>{tr("体积", "Volume")}: <strong>{formatVolume(order.volumeM3)}</strong></div><div>{tr("保证金", "Collateral")}: <strong>{formatIsk(order.collateral)}</strong></div><div>{tr("快递费", "Fee")}: <strong className="text-primary">{formatIsk(order.calculatedFee)}</strong></div></div>
              {order.note && <p className="whitespace-pre-wrap text-sm text-muted-foreground">{order.note}</p>}
              {order.internalNotes && !order.canManageStatus && <p className="text-sm text-muted-foreground">{tr("快递记录", "Courier note")}: {order.internalNotes}</p>}
              {order.canManageStatus && !["completed", "rejected", "cancelled"].includes(order.status) && <div className="space-y-2 border-t border-border/50 pt-3"><Textarea placeholder={tr("快递处理记录（完成后委托人可见）", "Courier note visible to the requester after completion") } value={internalNotes[order.id] ?? order.internalNotes ?? ""} onChange={(event) => setInternalNotes((current) => ({ ...current, [order.id]: event.target.value }))} /><div className="flex flex-wrap gap-2">{order.status === "submitted" && <><Button size="sm" onClick={() => advance(order, "accepted")}>{tr("接单", "Accept")}</Button><Button size="sm" variant="destructive" onClick={() => advance(order, "rejected")}>{tr("拒绝", "Reject")}</Button></>}{order.status === "accepted" && <Button size="sm" onClick={() => advance(order, "in_transit")}>{tr("开始运输", "Start transit")}</Button>}{order.status === "in_transit" && <Button size="sm" onClick={() => advance(order, "completed")}>{tr("完成快递", "Complete")}</Button>}{["submitted", "accepted", "in_transit"].includes(order.status) && <Button size="sm" variant="outline" onClick={() => advance(order, "cancelled")}>{tr("取消", "Cancel")}</Button>}</div></div>}
              {!order.canManageStatus && order.submittedBy === user?.id && order.status === "submitted" && <Button size="sm" variant="outline" onClick={() => advance(order, "cancelled")}>{tr("取消委托", "Cancel order")}</Button>}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
