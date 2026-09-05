import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  getListIntelBridgesQueryKey,
  getListMonitoredSystemsQueryKey,
  useCreateIntelBridgePairing,
  useCreateMonitoredSystem,
  useListIntelBridges,
  useListMonitoredSystems,
  useUpdateIntelBridge,
  useUpdateMonitoredSystem,
  type IntelBridgePairing,
} from "@workspace/api-client-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { getErrorMessage } from "@/lib/api-error";
import { useTranslation } from "react-i18next";
import {
  Copy,
  Download,
  Laptop,
  MapPin,
  Plus,
  Power,
  Radio,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

const BRIDGE_ONLINE_MS = 90_000;

function formatIsk(value: number): string {
  if (value >= 1_000_000_000)
    return `${(value / 1_000_000_000).toFixed(1)}b ISK`;
  return `${(value / 1_000_000).toFixed(0)}m ISK`;
}

export function AdminSystemMonitoring() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh");
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const systems = useListMonitoredSystems({
    query: { queryKey: getListMonitoredSystemsQueryKey() },
  });
  const bridges = useListIntelBridges({
    query: { queryKey: getListIntelBridgesQueryKey(), refetchInterval: 30_000 },
  });
  const createSystem = useCreateMonitoredSystem();
  const updateSystem = useUpdateMonitoredSystem();
  const createPairing = useCreateIntelBridgePairing();
  const updateBridge = useUpdateIntelBridge();
  const [solarSystemName, setSolarSystemName] = useState("");
  const [burstWindowMinutes, setBurstWindowMinutes] = useState("10");
  const [burstThreshold, setBurstThreshold] = useState("3");
  const [highValueBillions, setHighValueBillions] = useState("1");
  const [activityMultiplier, setActivityMultiplier] = useState("1.5");
  const [notes, setNotes] = useState("");
  const [pairing, setPairing] = useState<IntelBridgePairing | null>(null);
  const [channelDrafts, setChannelDrafts] = useState<Record<number, string>>(
    {},
  );

  const invalidateSystems = () =>
    queryClient.invalidateQueries({
      queryKey: getListMonitoredSystemsQueryKey(),
    });
  const invalidateBridges = () =>
    queryClient.invalidateQueries({ queryKey: getListIntelBridgesQueryKey() });

  const addSystem = () => {
    if (!solarSystemName.trim()) return;
    createSystem.mutate(
      {
        data: {
          solarSystemName: solarSystemName.trim(),
          burstWindowMinutes: Number(burstWindowMinutes),
          burstThreshold: Number(burstThreshold),
          highValueThreshold: Number(highValueBillions) * 1_000_000_000,
          activityMultiplier: Number(activityMultiplier),
          notes: notes.trim() || null,
        },
      },
      {
        onSuccess: async () => {
          setSolarSystemName("");
          setNotes("");
          await invalidateSystems();
          toast({ title: tr("监控星系已启用", "System monitoring enabled") });
        },
        onError: (error) =>
          toast({
            title: tr("无法添加星系", "Unable to add system"),
            description: getErrorMessage(error),
            variant: "destructive",
          }),
      },
    );
  };

  const toggleSystem = (id: number, isActive: boolean) =>
    updateSystem.mutate(
      { id, data: { isActive } },
      {
        onSuccess: invalidateSystems,
        onError: (error) =>
          toast({
            title: tr("更新失败", "Update failed"),
            description: getErrorMessage(error),
            variant: "destructive",
          }),
      },
    );

  const generatePairing = () =>
    createPairing.mutate(undefined, {
      onSuccess: setPairing,
      onError: (error) =>
        toast({
          title: tr("无法生成配对码", "Unable to create pairing code"),
          description: getErrorMessage(error),
          variant: "destructive",
        }),
    });

  const saveChannels = (bridgeId: number, fallback: string[]) => {
    const raw = channelDrafts[bridgeId] ?? fallback.join("\n");
    const channelNames = raw
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter(Boolean);
    updateBridge.mutate(
      { id: bridgeId, data: { channelNames } },
      {
        onSuccess: async () => {
          await invalidateBridges();
          toast({ title: tr("频道白名单已保存", "Channel allowlist saved") });
        },
        onError: (error) =>
          toast({
            title: tr("保存失败", "Save failed"),
            description: getErrorMessage(error),
            variant: "destructive",
          }),
      },
    );
  };

  const toggleBridge = (id: number, isActive: boolean) =>
    updateBridge.mutate(
      { id, data: { isActive } },
      {
        onSuccess: invalidateBridges,
        onError: (error) =>
          toast({
            title: tr("桥接器更新失败", "Bridge update failed"),
            description: getErrorMessage(error),
            variant: "destructive",
          }),
      },
    );

  return (
    <div className="p-6 space-y-6 overflow-auto">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold font-mono tracking-wider">
          <Radio className="h-6 w-6 text-primary" />
          {tr("星系监控管理", "SYSTEM MONITORING MANAGEMENT")}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {tr(
            "设置本军团监控范围、自动警报阈值和预警频道桥接器。",
            "Configure this corporation's monitoring scope, alert thresholds, and intel-channel bridges.",
          )}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MapPin className="h-5 w-5 text-primary" />
            {tr("添加监控星系", "Add monitored system")}
          </CardTitle>
          <CardDescription>
            {tr(
              "必须使用游戏内完整英文星系名称；系统会通过EVE ESI进行验证。",
              "Use the exact in-game system name; EVE ESI validates it.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <div className="space-y-2 xl:col-span-2">
              <Label>{tr("星系名称", "System name")}</Label>
              <Input
                value={solarSystemName}
                onChange={(event) => setSolarSystemName(event.target.value)}
                placeholder="1DQ1-A"
              />
            </div>
            <div className="space-y-2">
              <Label>
                {tr("连续击杀窗口（分钟）", "Burst window (minutes)")}
              </Label>
              <Input
                type="number"
                min={1}
                max={60}
                value={burstWindowMinutes}
                onChange={(event) => setBurstWindowMinutes(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{tr("触发条数", "Kill threshold")}</Label>
              <Input
                type="number"
                min={2}
                max={50}
                value={burstThreshold}
                onChange={(event) => setBurstThreshold(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>
                {tr("高价值阈值（十亿）", "High-value threshold (billions)")}
              </Label>
              <Input
                type="number"
                min={0}
                step={0.1}
                value={highValueBillions}
                onChange={(event) => setHighValueBillions(event.target.value)}
              />
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-[180px_1fr_auto] md:items-end">
            <div className="space-y-2">
              <Label>{tr("活动异常倍数", "Activity multiplier")}</Label>
              <Input
                type="number"
                min={1}
                max={20}
                step={0.1}
                value={activityMultiplier}
                onChange={(event) => setActivityMultiplier(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>{tr("监控备注", "Monitoring notes")}</Label>
              <Input
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder={tr(
                  "例如：主权入口与后勤交通线",
                  "e.g. sovereignty entrance and logistics route",
                )}
              />
            </div>
            <Button
              onClick={addSystem}
              disabled={!solarSystemName.trim() || createSystem.isPending}
            >
              <Plus className="mr-2 h-4 w-4" />
              {createSystem.isPending
                ? tr("验证中…", "Validating…")
                : tr("启用监控", "Enable")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {tr("监控星系列表", "Monitored systems")}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {systems.isLoading ? (
            <div className="p-6 text-sm text-muted-foreground">
              {tr("读取中…", "Loading…")}
            </div>
          ) : !systems.data?.length ? (
            <div className="p-6 text-sm text-muted-foreground">
              {tr("尚未添加星系。", "No systems added.")}
            </div>
          ) : (
            <div className="divide-y divide-border/50">
              {systems.data.map((system) => (
                <div
                  key={system.id}
                  className="flex flex-wrap items-center justify-between gap-4 p-4"
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">
                        {system.solarSystemName}
                      </span>
                      <Badge
                        variant={system.isActive ? "default" : "secondary"}
                      >
                        {system.isActive
                          ? tr("监控中", "ACTIVE")
                          : tr("已停用", "DISABLED")}
                      </Badge>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {system.burstWindowMinutes}
                      {tr("分钟内", "m / ")}
                      {system.burstThreshold}
                      {tr("条击杀触发 · 高价值", " kills · high value ")}
                      {formatIsk(system.highValueThreshold)} ·{" "}
                      {tr("活动", "activity ")}×{system.activityMultiplier}
                    </div>
                    {system.notes && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {system.notes}
                      </p>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => toggleSystem(system.id, !system.isActive)}
                    disabled={updateSystem.isPending}
                  >
                    <Power className="mr-2 h-4 w-4" />
                    {system.isActive
                      ? tr("停止监控", "Disable")
                      : tr("重新启用", "Enable")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Laptop className="h-5 w-5 text-primary" />
            {tr("预警频道桥接器", "Intel-channel bridge")}
          </CardTitle>
          <CardDescription>
            {tr(
              "下载桥接程序，在情报员电脑上运行后使用一次性配对码连接。配对码10分钟内有效。",
              "Download the bridge, run it on an intel operator's computer, and connect with a one-time 10-minute pairing code.",
            )}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <a href="/downloads/eve-intel-bridge.mjs" download>
                <Download className="mr-2 h-4 w-4" />
                {tr("下载桥接程序", "Download bridge")}
              </a>
            </Button>
            <Button
              onClick={generatePairing}
              disabled={createPairing.isPending}
            >
              <ShieldCheck className="mr-2 h-4 w-4" />
              {tr("生成配对码", "Create pairing code")}
            </Button>
            <Button variant="ghost" onClick={() => void invalidateBridges()}>
              <RefreshCw className="mr-2 h-4 w-4" />
              {tr("刷新设备", "Refresh devices")}
            </Button>
          </div>
          {pairing && (
            <div className="rounded-md border border-primary/40 bg-primary/5 p-4">
              <div className="text-xs text-muted-foreground">
                {tr("一次性配对码", "One-time pairing code")}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <code className="break-all text-lg font-bold tracking-wider text-primary">
                  {pairing.code}
                </code>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => navigator.clipboard.writeText(pairing.code)}
                >
                  <Copy className="mr-2 h-4 w-4" />
                  {tr("复制", "Copy")}
                </Button>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {tr("有效至：", "Expires: ")}
                {new Date(pairing.expiresAt).toLocaleString(
                  zh ? "zh-CN" : undefined,
                )}
              </p>
            </div>
          )}
          <div className="rounded-md border border-border/50 p-4 text-sm">
            <p className="font-medium">{tr("运行方式", "Run command")}</p>
            <code className="mt-2 block overflow-x-auto rounded bg-background p-3 text-xs">
              node eve-intel-bridge.mjs
            </code>
            <p className="mt-2 text-xs text-muted-foreground">
              {tr(
                "首次运行会询问网站地址、配对码、设备名称和EVE聊天日志目录。桥接器只上传包含监控星系名的频道消息。",
                "First run asks for the site URL, pairing code, device name, and EVE chat-log folder. Only channel lines containing monitored system names are uploaded.",
              )}
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {tr("已配对设备", "Paired devices")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {bridges.isLoading ? (
            <div className="text-sm text-muted-foreground">
              {tr("读取中…", "Loading…")}
            </div>
          ) : !bridges.data?.length ? (
            <div className="text-sm text-muted-foreground">
              {tr("还没有桥接器。", "No bridge devices yet.")}
            </div>
          ) : (
            bridges.data.map((bridge) => {
              const online =
                bridge.isActive &&
                Boolean(
                  bridge.lastSeenAt &&
                  Date.now() - new Date(bridge.lastSeenAt).getTime() <=
                    BRIDGE_ONLINE_MS,
                );
              const draft =
                channelDrafts[bridge.id] ?? bridge.channelNames.join("\n");
              const ownerLabel =
                bridge.ownerName ??
                (bridge.ownerUserId
                  ? `#${bridge.ownerUserId}`
                  : tr("原配对成员", "former member"));
              return (
                <div
                  key={bridge.id}
                  className="rounded-md border border-border/50 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{bridge.name}</span>
                        <Badge
                          variant="outline"
                          className={
                            online
                              ? "border-emerald-500/50 text-emerald-300"
                              : "border-amber-500/50 text-amber-300"
                          }
                        >
                          {online
                            ? tr("在线", "ONLINE")
                            : bridge.isActive
                              ? tr("离线", "OFFLINE")
                              : tr("已撤销", "REVOKED")}
                        </Badge>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        {ownerLabel} ·{" "}
                        {bridge.devicePlatform ??
                          tr("未知平台", "unknown platform")}
                        {bridge.lastSeenAt
                          ? ` · ${tr("最后在线", "last seen ")} ${new Date(bridge.lastSeenAt).toLocaleString(zh ? "zh-CN" : undefined)}`
                          : ""}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => toggleBridge(bridge.id, !bridge.isActive)}
                    >
                      {bridge.isActive
                        ? tr("撤销令牌", "Revoke")
                        : tr("重新启用", "Enable")}
                    </Button>
                  </div>
                  <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <div className="space-y-2">
                      <Label>
                        {tr(
                          "允许读取的频道名称（每行一个）",
                          "Allowed channel names (one per line)",
                        )}
                      </Label>
                      <Textarea
                        value={draft}
                        onChange={(event) =>
                          setChannelDrafts((current) => ({
                            ...current,
                            [bridge.id]: event.target.value,
                          }))
                        }
                        placeholder={tr(
                          "联盟预警\n北方情报",
                          "Alliance Intel\nNorthern Intel",
                        )}
                      />
                    </div>
                    <Button
                      variant="secondary"
                      onClick={() =>
                        saveChannels(bridge.id, bridge.channelNames)
                      }
                      disabled={updateBridge.isPending}
                    >
                      {tr("保存频道", "Save channels")}
                    </Button>
                  </div>
                  {bridge.lastError && (
                    <p className="mt-3 text-xs text-rose-300">
                      {bridge.lastError}
                    </p>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>
    </div>
  );
}
