import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetCourierAdminDataQueryKey,
  useCreateCourierAgent,
  useCreateCourierRoute,
  useGetCourierAdminData,
  useUpdateCourierAgent,
  useUpdateCourierRoute,
  type CourierPricingMethod,
  type CourierRoute,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { MapPinned, Save, Truck, UserPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

type RouteDraft = {
  id: number | null;
  courierAgentId: string;
  origin: string;
  destination: string;
  pricingMethod: CourierPricingMethod;
  baseFee: string;
  pricePerM3: string;
  collateralRate: string;
  isActive: boolean;
};

const emptyRoute = (): RouteDraft => ({ id: null, courierAgentId: "", origin: "", destination: "", pricingMethod: "fixed", baseFee: "", pricePerM3: "0", collateralRate: "0", isActive: true });
const formatIsk = (value: number) => `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(value)} ISK`;

export function AdminCourier() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const admin = useGetCourierAdminData();
  const createAgent = useCreateCourierAgent();
  const updateAgent = useUpdateCourierAgent();
  const createRoute = useCreateCourierRoute();
  const updateRoute = useUpdateCourierRoute();
  const [candidateId, setCandidateId] = useState("");
  const [agentNames, setAgentNames] = useState<Record<number, string>>({});
  const [route, setRoute] = useState<RouteDraft>(emptyRoute());
  const refresh = () => queryClient.invalidateQueries({ queryKey: getGetCourierAdminDataQueryKey() });
  const availableCandidates = useMemo(() => (admin.data?.candidates ?? []).filter((candidate) => !candidate.isCourier), [admin.data]);
  const activeAgents = (admin.data?.agents ?? []).filter((agent) => agent.isActive);
  const pricingLabels: Record<CourierPricingMethod, string> = {
    fixed: tr("固定价格", "Fixed fee"), volume: tr("按体积", "Volume"), collateral: tr("按保证金", "Collateral"), volume_collateral: tr("体积与保证金组合", "Volume and collateral"),
  };

  const addAgent = () => {
    if (!candidateId) return;
    createAgent.mutate({ data: { userId: Number(candidateId) } }, {
      onSuccess: async () => { setCandidateId(""); await refresh(); toast({ title: tr("快递员已新增", "Courier added") }); },
      onError: (error) => toast({ title: tr("新增失败", "Add failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const saveAgent = (agent: NonNullable<typeof admin.data>["agents"][number], isActive = agent.isActive) => {
    updateAgent.mutate({ id: agent.id, data: { name: agentNames[agent.id] ?? agent.name, isActive } }, {
      onSuccess: refresh,
      onError: (error) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" }),
    });
  };

  const loadRoute = (item: CourierRoute) => setRoute({ id: item.id, courierAgentId: String(item.courierAgentId), origin: item.origin, destination: item.destination, pricingMethod: item.pricingMethod, baseFee: String(item.baseFee), pricePerM3: String(item.pricePerM3), collateralRate: String(item.collateralRate), isActive: item.isActive });
  const saveRoute = () => {
    const data = { courierAgentId: Number(route.courierAgentId), origin: route.origin, destination: route.destination, pricingMethod: route.pricingMethod, baseFee: Number(route.baseFee || 0), pricePerM3: Number(route.pricePerM3 || 0), collateralRate: Number(route.collateralRate || 0), isActive: route.isActive };
    const options = { onSuccess: async () => { setRoute(emptyRoute()); await refresh(); toast({ title: tr("快递线路已保存", "Courier route saved") }); }, onError: (error: unknown) => toast({ title: tr("保存失败", "Save failed"), description: getErrorMessage(error), variant: "destructive" as const }) };
    if (route.id === null) createRoute.mutate({ data }, options);
    else updateRoute.mutate({ id: route.id, data }, options);
  };

  const toggleRoute = (item: CourierRoute) => updateRoute.mutate({ id: item.id, data: { courierAgentId: item.courierAgentId, origin: item.origin, destination: item.destination, pricingMethod: item.pricingMethod, baseFee: item.baseFee, pricePerM3: item.pricePerM3, collateralRate: item.collateralRate, isActive: !item.isActive } }, { onSuccess: refresh });

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div><h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider"><Truck className="h-6 w-6 text-primary" />{tr("快递管理", "COURIER ADMINISTRATION")}</h1><p className="mt-1 text-sm text-muted-foreground">{tr("新增快递员，并为每位快递员配置可选起点、终点和独立计费方式。", "Add couriers and configure routes and pricing independently for each courier.")}</p></div>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><UserPlus className="h-5 w-5" />{tr("快递员", "Couriers")}</CardTitle><CardDescription>{tr("只能从本军团已绑定网站的成员中选择。停用快递员会同时停用其线路。", "Only bound corporation members can be selected. Disabling a courier also disables their routes.")}</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row"><select className="h-10 flex-1 rounded-md border border-input bg-background px-3" value={candidateId} onChange={(event) => setCandidateId(event.target.value)}><option value="">{tr("选择军团成员", "Select corporation member")}</option>{availableCandidates.map((candidate) => <option key={candidate.userId} value={candidate.userId}>{candidate.name}</option>)}</select><Button disabled={!candidateId || createAgent.isPending} onClick={addAgent}><UserPlus className="mr-2 h-4 w-4" />{tr("新增快递员", "Add courier")}</Button></div>
          {(admin.data?.agents ?? []).map((agent) => <div key={agent.id} className="flex flex-col gap-3 rounded-md border border-border/50 p-4 sm:flex-row sm:items-center"><Input className="flex-1" value={agentNames[agent.id] ?? agent.name} onChange={(event) => setAgentNames((current) => ({ ...current, [agent.id]: event.target.value }))} /><Badge variant={agent.isActive ? "default" : "secondary"}>{agent.isActive ? tr("启用", "Active") : tr("停用", "Inactive")}</Badge><span className="text-xs text-muted-foreground">{agent.routeCount} {tr("条线路", "routes")}</span><Button size="sm" variant="outline" onClick={() => saveAgent(agent)}><Save className="mr-2 h-4 w-4" />{tr("保存名称", "Save name")}</Button><Button size="sm" variant={agent.isActive ? "destructive" : "default"} onClick={() => saveAgent(agent, !agent.isActive)}>{agent.isActive ? tr("停用", "Disable") : tr("启用", "Enable")}</Button></div>)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="flex items-center gap-2"><MapPinned className="h-5 w-5" />{route.id ? tr("编辑快递线路", "Edit courier route") : tr("新增快递线路", "New courier route")}</CardTitle><CardDescription>{tr("保证金费率使用百分比，例如填写 1 表示保证金的 1%。", "Collateral rate is a percentage; enter 1 for one percent of collateral.")}</CardDescription></CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2"><Label>{tr("快递员", "Courier")}</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3" value={route.courierAgentId} onChange={(event) => setRoute({ ...route, courierAgentId: event.target.value })}><option value="">{tr("选择快递员", "Select courier")}</option>{activeAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>
          <div className="space-y-2"><Label>{tr("计算方法", "Pricing method")}</Label><select className="h-10 w-full rounded-md border border-input bg-background px-3" value={route.pricingMethod} onChange={(event) => setRoute({ ...route, pricingMethod: event.target.value as CourierPricingMethod })}>{Object.entries(pricingLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>
          <div className="space-y-2"><Label>{tr("起点", "Origin")}</Label><Input value={route.origin} onChange={(event) => setRoute({ ...route, origin: event.target.value })} placeholder={tr("空间站或建筑完整名称", "Station or structure name")} /></div>
          <div className="space-y-2"><Label>{tr("终点", "Destination")}</Label><Input value={route.destination} onChange={(event) => setRoute({ ...route, destination: event.target.value })} placeholder={tr("空间站或建筑完整名称", "Station or structure name")} /></div>
          <div className="space-y-2"><Label>{tr("基础／固定快递费（ISK）", "Base or fixed fee (ISK)")}</Label><Input type="number" min="0" value={route.baseFee} onChange={(event) => setRoute({ ...route, baseFee: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("每 m³ 快递费（ISK）", "Fee per m³ (ISK)")}</Label><Input type="number" min="0" value={route.pricePerM3} disabled={!['volume', 'volume_collateral'].includes(route.pricingMethod)} onChange={(event) => setRoute({ ...route, pricePerM3: event.target.value })} /></div>
          <div className="space-y-2"><Label>{tr("保证金费率（%）", "Collateral rate (%)")}</Label><Input type="number" min="0" max="100" step="0.01" value={route.collateralRate} disabled={!['collateral', 'volume_collateral'].includes(route.pricingMethod)} onChange={(event) => setRoute({ ...route, collateralRate: event.target.value })} /></div>
          <label className="flex items-center gap-2 self-end pb-3 text-sm"><input type="checkbox" checked={route.isActive} onChange={(event) => setRoute({ ...route, isActive: event.target.checked })} />{tr("线路立即启用", "Route active")}</label>
          <div className="flex gap-2 md:col-span-2"><Button className="flex-1" disabled={!route.courierAgentId || !route.origin.trim() || !route.destination.trim() || createRoute.isPending || updateRoute.isPending} onClick={saveRoute}><Save className="mr-2 h-4 w-4" />{tr("保存线路与计费规则", "Save route and pricing")}</Button>{route.id && <Button variant="outline" onClick={() => setRoute(emptyRoute())}>{tr("取消编辑", "Cancel edit")}</Button>}</div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>{tr("已有线路", "Configured routes")}</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {(admin.data?.routes ?? []).length === 0 ? <p className="text-sm text-muted-foreground">{tr("暂无快递线路", "No courier routes")}</p> : (admin.data?.routes ?? []).map((item) => <div key={item.id} className="flex flex-col gap-3 rounded-md border border-border/50 p-4 lg:flex-row lg:items-center"><div className="flex-1"><div className="font-medium">{item.origin} → {item.destination}</div><div className="mt-1 text-xs text-muted-foreground">{item.courierName} · {pricingLabels[item.pricingMethod]} · {tr("基础费", "Base")} {formatIsk(item.baseFee)} · {formatIsk(item.pricePerM3)}/m³ · {item.collateralRate}%</div></div><Badge variant={item.isActive ? "default" : "secondary"}>{item.isActive ? tr("启用", "Active") : tr("停用", "Inactive")}</Badge><Button size="sm" variant="outline" onClick={() => loadRoute(item)}>{tr("编辑", "Edit")}</Button><Button size="sm" variant={item.isActive ? "destructive" : "default"} onClick={() => toggleRoute(item)}>{item.isActive ? tr("停用", "Disable") : tr("启用", "Enable")}</Button></div>)}
        </CardContent>
      </Card>
    </div>
  );
}
