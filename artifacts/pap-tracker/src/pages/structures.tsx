import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetCorporationStructures,
  useSyncCorporationStructures,
  type CorporationStructure,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { apiUrl } from "@/lib/api";
import { useTranslation } from "react-i18next";
import {
  Building2,
  Clock3,
  Fuel,
  MapPin,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";

const DAY_MS = 24 * 60 * 60 * 1_000;

function remainingFuel(expiresAt: string | null, now: number, zh: boolean) {
  if (!expiresAt) {
    return {
      level: "unknown" as const,
      label: zh ? "ESI 未提供燃料到期时间" : "Fuel expiry not provided by ESI",
    };
  }
  const remaining = new Date(expiresAt).getTime() - now;
  if (remaining <= 0) {
    return { level: "expired" as const, label: zh ? "已到期 / 可能耗尽" : "Expired / possibly depleted" };
  }
  const days = Math.floor(remaining / DAY_MS);
  const hours = Math.floor((remaining % DAY_MS) / (60 * 60 * 1_000));
  const minutes = Math.max(1, Math.floor((remaining % (60 * 60 * 1_000)) / 60_000));
  const label = days > 0
    ? (zh ? `${days} 天 ${hours} 小时` : `${days}d ${hours}h`)
    : hours > 0
      ? (zh ? `${hours} 小时 ${minutes} 分钟` : `${hours}h ${minutes}m`)
      : (zh ? `${minutes} 分钟` : `${minutes}m`);
  return {
    level: remaining < DAY_MS ? "critical" as const : remaining < 7 * DAY_MS ? "warning" as const : "healthy" as const,
    label,
  };
}

function stateLabel(state: string, zh: boolean): string {
  if (!zh) return state.replaceAll("_", " ");
  const labels: Record<string, string> = {
    anchor_vulnerable: "锚定完成，可受攻击",
    anchoring: "锚定中",
    armor_reinforce: "装甲增强期",
    armor_vulnerable: "装甲脆弱期",
    deploy_vulnerable: "部署脆弱期",
    fitting_invulnerable: "装配无敌期",
    hull_reinforce: "结构增强期",
    hull_vulnerable: "结构脆弱期",
    online_deprecated: "在线",
    onlining_vulnerable: "上线中，可受攻击",
    shield_vulnerable: "护盾脆弱期",
    unanchored: "已解除锚定",
    unknown: "未知",
  };
  return labels[state] ?? state.replaceAll("_", " ");
}

function fuelBadgeClass(level: ReturnType<typeof remainingFuel>["level"]): string {
  if (level === "healthy") return "border-emerald-500/50 bg-emerald-500/10 text-emerald-300";
  if (level === "warning") return "border-amber-500/50 bg-amber-500/10 text-amber-300";
  if (level === "critical" || level === "expired") return "border-rose-500/50 bg-rose-500/10 text-rose-300";
  return "border-slate-500/50 bg-slate-500/10 text-slate-300";
}

export function Structures() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => zh ? cn : en;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const dashboard = useGetCorporationStructures();
  const sync = useSyncCorporationStructures();
  const [now, setNow] = useState(Date.now());
  const [query, setQuery] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const data = dashboard.data;
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return data?.structures ?? [];
    return (data?.structures ?? []).filter((structure) =>
      [structure.name, structure.typeName, structure.systemName, structure.state]
        .some((value) => value.toLocaleLowerCase().includes(needle)),
    );
  }, [data?.structures, query]);

  const metrics = useMemo(() => {
    const structures = data?.structures ?? [];
    return structures.reduce((result, structure) => {
      const fuel = remainingFuel(structure.fuelExpiresAt, now, zh);
      if (fuel.level === "expired" || fuel.level === "critical") result.urgent += 1;
      if (fuel.level === "warning") result.warning += 1;
      if (fuel.level === "unknown") result.unknown += 1;
      return result;
    }, { urgent: 0, warning: 0, unknown: 0 });
  }, [data?.structures, now, zh]);

  const synchronize = () => sync.mutate(undefined, {
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/structures"] });
      toast({ title: tr("军团建筑已同步", "Corporation structures synchronized") });
    },
    onError: (error) => toast({
      title: tr("建筑同步失败", "Structure synchronization failed"),
      description: getErrorMessage(error),
      variant: "destructive",
    }),
  });

  if (dashboard.isLoading) {
    return <div className="p-6 text-muted-foreground">{tr("正在读取军团建筑并检查燃料…", "Loading corporation structures and fuel status…")}</div>;
  }
  if (dashboard.isError) {
    return <div className="p-6 text-destructive">{getErrorMessage(dashboard.error)}</div>;
  }

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider">
            <Building2 className="h-6 w-6 text-primary" />
            {tr("建筑浏览", "CORPORATION STRUCTURES")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {tr("仅展示当前军团通过 EVE ESI 返回的建筑、服务和燃料到期时间。", "Only structures, services, and fuel expiry returned by EVE ESI for this corporation are shown.")}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a href={apiUrl("/api/structures/connect")}>
              <ShieldCheck className="mr-2 h-4 w-4" />
              {data?.connection ? tr("重新授权", "Reauthorize") : tr("授权建筑读取", "Authorize structures")}
            </a>
          </Button>
          <Button onClick={synchronize} disabled={!data?.connection || sync.isPending}>
            <RefreshCw className={`mr-2 h-4 w-4 ${sync.isPending ? "animate-spin" : ""}`} />
            {tr("立即同步", "Sync now")}
          </Button>
        </div>
      </div>

      {!data?.connection && (
        <Card className="border-amber-500/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base"><TriangleAlert className="h-5 w-5 text-amber-400" />{tr("需要独立授权", "Separate authorization required")}</CardTitle>
            <CardDescription>{tr("请由属于当前军团、拥有 Station Manager（空间站管理员）权限的角色授权。普通网站登录不会申请该敏感权限。", "Authorize with a character in this corporation who has the Station Manager role. Regular website login never requests this sensitive scope.")}</CardDescription>
          </CardHeader>
        </Card>
      )}

      {data?.connection?.lastError && (
        <Card className="border-rose-500/40 bg-rose-500/5">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base text-rose-300"><TriangleAlert className="h-5 w-5" />{tr("最近一次同步失败", "Latest synchronization failed")}</CardTitle>
            <CardDescription className="text-rose-200/80">{data.connection.lastError}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Metric label={tr("军团建筑", "Structures")} value={data?.structures.length ?? 0} icon={<Building2 className="h-5 w-5" />} />
        <Metric label={tr("24 小时内需处理", "Needs attention in 24h")} value={metrics.urgent} icon={<TriangleAlert className="h-5 w-5 text-rose-400" />} />
        <Metric label={tr("7 天内到期", "Expires within 7 days")} value={metrics.warning} icon={<Fuel className="h-5 w-5 text-amber-400" />} />
        <Metric label={tr("燃料时间未知", "Unknown fuel expiry")} value={metrics.unknown} icon={<Clock3 className="h-5 w-5 text-slate-400" />} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="pl-9" placeholder={tr("搜索建筑名称、类型、星系或状态", "Search name, type, system, or state")} />
        </div>
        <div className="text-xs text-muted-foreground">
          {data?.connection?.lastSyncedAt
            ? tr(`最近同步：${new Date(data.connection.lastSyncedAt).toLocaleString("zh-CN")}`, `Last sync: ${new Date(data.connection.lastSyncedAt).toLocaleString()}`)
            : tr("尚未完成首次同步", "Initial synchronization not completed")}
        </div>
      </div>

      {filtered.length === 0 ? (
        <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">{query ? tr("没有匹配的建筑。", "No matching structures.") : data?.connection ? tr("EVE ESI 没有返回当前军团可见的建筑。", "EVE ESI returned no visible structures for this corporation.") : tr("授权后将自动读取军团建筑。", "Corporation structures will load automatically after authorization.")}</CardContent></Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {filtered.map((structure) => <StructureCard key={structure.structureId} structure={structure} now={now} zh={zh} />)}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return <Card><CardHeader className="pb-2"><CardDescription className="flex items-center justify-between">{label}{icon}</CardDescription></CardHeader><CardContent><div className="text-2xl font-bold font-mono">{value}</div></CardContent></Card>;
}

function StructureCard({ structure, now, zh }: { structure: CorporationStructure; now: number; zh: boolean }) {
  const fuel = remainingFuel(structure.fuelExpiresAt, now, zh);
  const onlineServices = structure.services.filter((service) => service.state === "online").length;
  return (
    <Card className={fuel.level === "expired" || fuel.level === "critical" ? "border-rose-500/40" : fuel.level === "warning" ? "border-amber-500/40" : ""}>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="truncate text-lg">{structure.name}</CardTitle>
            <CardDescription className="mt-1">{structure.typeName}</CardDescription>
          </div>
          <Badge variant="outline">{stateLabel(structure.state, zh)}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-2 text-sm"><MapPin className="h-4 w-4 text-primary" /><span>{structure.systemName}</span></div>
        <div className={`rounded-md border p-3 ${fuelBadgeClass(fuel.level)}`}>
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium"><Fuel className="h-4 w-4" />{zh ? "剩余燃料时间" : "Fuel remaining"}</span>
            <span className="font-mono text-sm font-bold">{fuel.label}</span>
          </div>
          {structure.fuelExpiresAt && <div className="mt-1 text-right text-xs opacity-80">{zh ? "预计到期：" : "Expected expiry: "}{new Date(structure.fuelExpiresAt).toLocaleString(zh ? "zh-CN" : undefined)}</div>}
        </div>
        <div>
          <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground"><span>{zh ? "建筑服务" : "Structure services"}</span><span>{onlineServices}/{structure.services.length} {zh ? "在线" : "online"}</span></div>
          {structure.services.length === 0 ? <p className="text-xs text-muted-foreground">{zh ? "ESI 未提供服务信息" : "No service data provided by ESI"}</p> : <div className="flex flex-wrap gap-2">{structure.services.map((service) => <Badge key={`${service.name}-${service.state}`} variant="secondary" className={service.state === "online" ? "text-emerald-300" : service.state === "cleanup" ? "text-amber-300" : "text-muted-foreground"}>{service.name} · {service.state}</Badge>)}</div>}
        </div>
        {(structure.stateTimerEnd || structure.unanchorsAt) && <div className="space-y-1 border-t border-border/50 pt-3 text-xs text-muted-foreground">{structure.stateTimerEnd && <div>{zh ? "状态计时结束：" : "State timer ends: "}{new Date(structure.stateTimerEnd).toLocaleString(zh ? "zh-CN" : undefined)}</div>}{structure.unanchorsAt && <div>{zh ? "解除锚定：" : "Unanchors at: "}{new Date(structure.unanchorsAt).toLocaleString(zh ? "zh-CN" : undefined)}</div>}</div>}
      </CardContent>
    </Card>
  );
}
