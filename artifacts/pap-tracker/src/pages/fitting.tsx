import { useEffect, useMemo, useState } from "react";
import {
  type FittingCatalogItem,
  type FittingSimulationResult,
  useSearchFittingCatalog,
  useSimulateFitting,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  Gauge,
  Layers3,
  Lightbulb,
  Loader2,
  Plus,
  Radar,
  Search,
  Shield,
  Ship,
  Target,
  Trash2,
  Zap,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type FittingLanguage = "en" | "zh";
type FittingMode = "pvp" | "pve";
type CatalogCategoryFilter = "module" | "charge" | "drone";
type FittingSlotFilter = "all" | "high" | "medium" | "low" | "rig" | "subsystem" | "other";
type SelectedModule = FittingCatalogItem & { quantity: number };

const rackOrder = ["high", "medium", "low", "rig", "subsystem", "drone", "charge", "other"] as const;
const trackedRackSlots = new Set(["high", "medium", "low", "rig", "subsystem"]);

function language(): FittingLanguage {
  return i18n.language === "en" ? "en" : "zh";
}

function numberLabel(value: number | null | undefined, digits = 0): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function ResourceBar({
  label,
  metric,
}: {
  label: string;
  metric: FittingSimulationResult["resources"]["cpu"];
}) {
  const width = Math.min(metric.percent || 0, 140);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3 font-mono text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className={metric.overloaded ? "text-destructive" : "text-foreground"}>
          {numberLabel(metric.used, 1)} / {numberLabel(metric.limit, 1)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-sm bg-muted/40">
        <div
          className={`h-full ${metric.overloaded ? "bg-destructive" : "bg-primary"}`}
          style={{ width: `${width}%` }}
        />
      </div>
    </div>
  );
}

function SlotBadge({
  label,
  metric,
}: {
  label: string;
  metric: FittingSimulationResult["slots"]["high"];
}) {
  return (
    <Badge
      variant="outline"
      className={`rounded-sm font-mono text-[10px] ${
        metric.overloaded
          ? "border-destructive/50 text-destructive"
          : "border-border/50 text-muted-foreground"
      }`}
    >
      {label} {metric.used}/{metric.limit}
    </Badge>
  );
}

function typeIconUrl(typeId: number): string {
  return `https://images.evetech.net/types/${typeId}/icon?size=64`;
}

export function Fitting() {
  const { t } = useTranslation();
  const lng = language();
  const [mode, setMode] = useState<FittingMode>("pvp");
  const [shipSearch, setShipSearch] = useState(lng === "zh" ? "特里斯坦" : "Tristan");
  const [moduleSearch, setModuleSearch] = useState("");
  const [itemCategory, setItemCategory] = useState<CatalogCategoryFilter>("module");
  const [slotFilter, setSlotFilter] = useState<FittingSlotFilter>("all");
  const [selectedShip, setSelectedShip] = useState<FittingCatalogItem | null>(null);
  const [selectedModules, setSelectedModules] = useState<SelectedModule[]>([]);

  const shipCatalog = useSearchFittingCatalog(
    { q: shipSearch, category: "ship", language: lng, limit: 18 },
    { query: { queryKey: ["fittingShips", shipSearch, lng] } },
  );
  const moduleCatalog = useSearchFittingCatalog(
    {
      q: moduleSearch,
      category: itemCategory,
      slot: itemCategory === "module" ? slotFilter : "all",
      language: lng,
      limit: 35,
    },
    { query: { queryKey: ["fittingCatalog", moduleSearch, itemCategory, slotFilter, lng], enabled: !!selectedShip } },
  );
  const simulate = useSimulateFitting();

  useEffect(() => {
    if (selectedShip || !shipCatalog.data?.items.length) return;
    setSelectedShip(shipCatalog.data.items[0]);
  }, [selectedShip, shipCatalog.data]);

  const modulePayload = useMemo(
    () => selectedModules.map((module) => ({ typeId: module.typeId, quantity: module.quantity })),
    [selectedModules],
  );
  const modulePayloadKey = useMemo(() => JSON.stringify(modulePayload), [modulePayload]);

  useEffect(() => {
    if (!selectedShip) return;
    simulate.mutate({
      data: {
        shipId: selectedShip.typeId,
        modules: modulePayload,
        mode,
        language: lng,
      },
    });
  }, [selectedShip?.typeId, modulePayloadKey, mode, lng]);

  const simulation = simulate.data;
  const modulesByRack = useMemo(() => {
    return Object.fromEntries(
      rackOrder.map((rack) => [rack, selectedModules.filter((module) => module.slot === rack)]),
    ) as Record<typeof rackOrder[number], SelectedModule[]>;
  }, [selectedModules]);

  const addModule = (item: FittingCatalogItem) => {
    setSelectedModules((current) => {
      const existing = current.find((module) => module.typeId === item.typeId);
      if (existing) {
        return current.map((module) =>
          module.typeId === item.typeId ? { ...module, quantity: module.quantity + 1 } : module,
        );
      }
      return [...current, { ...item, quantity: 1 }];
    });
  };

  const removeModule = (typeId: number) => {
    setSelectedModules((current) => current.filter((module) => module.typeId !== typeId));
  };

  const changeQuantity = (typeId: number, delta: number) => {
    setSelectedModules((current) =>
      current.flatMap((module) => {
        if (module.typeId !== typeId) return [module];
        const quantity = module.quantity + delta;
        return quantity > 0 ? [{ ...module, quantity }] : [];
      }),
    );
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <h1 className="text-2xl font-bold font-mono tracking-wider uppercase flex items-center gap-3">
            <Ship className="w-6 h-6 text-primary" />
            {t("fitting.title")}
          </h1>
          <p className="text-muted-foreground font-mono text-sm mt-1">{t("fitting.subtitle")}</p>
        </div>
        <div className="flex rounded-sm border border-border/50 overflow-hidden font-mono text-xs">
          {(["pvp", "pve"] as const).map((nextMode) => (
            <button
              key={nextMode}
              type="button"
              onClick={() => setMode(nextMode)}
              className={`px-4 py-2 transition-colors ${
                mode === nextMode ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t(`fitting.modes.${nextMode}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 xl:grid-cols-[320px_minmax(0,1fr)]">
        <div className="space-y-6">
          <Card className="bg-card/35 border-border/50 rounded-sm">
            <CardHeader className="border-b border-border/30 pb-4">
              <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
                <Search className="w-4 h-4 text-primary" />
                {t("fitting.shipSearch")}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <Input
                value={shipSearch}
                onChange={(event) => setShipSearch(event.target.value)}
                className="bg-background/50 border-border/50 rounded-sm font-mono text-xs"
                placeholder={t("fitting.shipPlaceholder")}
              />
              <div className="max-h-72 overflow-y-auto space-y-2 pr-1">
                {shipCatalog.isLoading ? (
                  <div className="py-6 flex justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  </div>
                ) : (
                  shipCatalog.data?.items.map((ship) => (
                    <button
                      type="button"
                      key={ship.typeId}
                      onClick={() => {
                        setSelectedShip(ship);
                        setSelectedModules([]);
                      }}
                      className={`w-full rounded-sm border px-3 py-2 text-left transition-colors ${
                        selectedShip?.typeId === ship.typeId
                          ? "border-primary/50 bg-primary/10"
                          : "border-border/40 hover:border-primary/30 hover:bg-primary/5"
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <img src={typeIconUrl(ship.typeId)} alt="" className="h-9 w-9 rounded-sm bg-background/70" />
                        <div className="min-w-0">
                          <p className="truncate font-mono text-sm text-foreground">{ship.name}</p>
                          <p className="truncate font-mono text-[11px] text-muted-foreground">{ship.groupName}</p>
                        </div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </CardContent>
          </Card>

          <Card className="bg-card/35 border-border/50 rounded-sm">
            <CardHeader className="border-b border-border/30 pb-4">
              <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
                <Layers3 className="w-4 h-4 text-primary" />
                {t("fitting.moduleSearch")}
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <Input
                value={moduleSearch}
                onChange={(event) => setModuleSearch(event.target.value)}
                className="bg-background/50 border-border/50 rounded-sm font-mono text-xs"
                placeholder={t("fitting.modulePlaceholder")}
                disabled={!selectedShip}
              />
              <div className="grid grid-cols-3 gap-2">
                {(["module", "charge", "drone"] as const).map((category) => (
                  <Button
                    key={category}
                    type="button"
                    size="sm"
                    variant={itemCategory === category ? "default" : "outline"}
                    className="h-8 rounded-sm px-2 font-mono text-[10px]"
                    onClick={() => setItemCategory(category)}
                  >
                    {t(`fitting.categories.${category}`)}
                  </Button>
                ))}
              </div>
              {itemCategory === "module" && (
                <div className="flex flex-wrap gap-2">
                  {(["all", "high", "medium", "low", "rig", "subsystem", "other"] as const).map((slot) => (
                  <Button
                    key={slot}
                    type="button"
                    size="sm"
                    variant={slotFilter === slot ? "default" : "outline"}
                    className="h-7 rounded-sm px-2 font-mono text-[10px]"
                    onClick={() => setSlotFilter(slot)}
                  >
                    {t(`fitting.slots.${slot}`)}
                  </Button>
                  ))}
                </div>
              )}
              <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
                {moduleCatalog.isLoading ? (
                  <div className="py-6 flex justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-primary" />
                  </div>
                ) : (
                  moduleCatalog.data?.items.map((module) => (
                    <div
                      key={module.typeId}
                      className="flex items-center justify-between gap-3 rounded-sm border border-border/40 px-3 py-2"
                    >
                      <div className="flex min-w-0 items-center gap-3">
                        <img src={typeIconUrl(module.typeId)} alt="" className="h-8 w-8 rounded-sm bg-background/70" />
                        <div className="min-w-0">
                          <p className="truncate font-mono text-xs text-foreground">{module.name}</p>
                          <p className="truncate font-mono text-[10px] text-muted-foreground">
                            {module.groupName} · {t(`fitting.categories.${module.category}`)} · {t(`fitting.slots.${module.slot}`)}
                          </p>
                        </div>
                      </div>
                      <Button size="icon" variant="ghost" className="h-7 w-7 rounded-sm" onClick={() => addModule(module)}>
                        <Plus className="h-4 w-4" />
                      </Button>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="bg-card/35 border-border/50 rounded-sm">
            <CardContent className="p-5">
              {selectedShip ? (
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex items-center gap-4">
                    <img src={typeIconUrl(selectedShip.typeId)} alt="" className="h-16 w-16 rounded-sm bg-background/70" />
                    <div>
                      <h2 className="font-mono text-lg font-bold text-foreground">{selectedShip.name}</h2>
                      <p className="font-mono text-xs text-muted-foreground">
                        {selectedShip.groupName} · SDE {simulation?.sdeBuildNumber ?? shipCatalog.data?.sdeBuildNumber ?? "—"}
                      </p>
                    </div>
                  </div>
                  {simulation && (
                    <div className="flex flex-wrap gap-2">
                      <SlotBadge label={t("fitting.slots.high")} metric={simulation.slots.high} />
                      <SlotBadge label={t("fitting.slots.medium")} metric={simulation.slots.medium} />
                      <SlotBadge label={t("fitting.slots.low")} metric={simulation.slots.low} />
                      <SlotBadge label={t("fitting.slots.rig")} metric={simulation.slots.rig} />
                    </div>
                  )}
                </div>
              ) : (
                <div className="py-10 text-center font-mono text-sm text-muted-foreground">{t("fitting.pickShip")}</div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
            <Card className="bg-card/35 border-border/50 rounded-sm">
              <CardHeader className="border-b border-border/30 pb-4">
                <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
                  <Layers3 className="w-4 h-4 text-primary" />
                  {t("fitting.currentFit")}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {selectedModules.length === 0 ? (
                  <div className="p-8 text-center font-mono text-sm text-muted-foreground">{t("fitting.emptyFit")}</div>
                ) : (
                  <div className="divide-y divide-border/30">
                    {rackOrder.map((rack) => (
                      <div key={rack} className="p-4">
                        <div className="mb-3 flex items-center justify-between">
                          <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground">{t(`fitting.slots.${rack}`)}</h3>
                          {simulation && trackedRackSlots.has(rack) && (
                            <SlotBadge
                              label={t(`fitting.slots.${rack}`)}
                              metric={simulation.slots[rack as keyof typeof simulation.slots]}
                            />
                          )}
                        </div>
                        {modulesByRack[rack].length === 0 ? (
                          <p className="font-mono text-xs text-muted-foreground">{t("fitting.emptyRack")}</p>
                        ) : (
                          <div className="space-y-2">
                            {modulesByRack[rack].map((module) => (
                              <div key={module.typeId} className="flex items-center justify-between gap-3 rounded-sm bg-background/35 px-3 py-2">
                                <div className="min-w-0">
                                  <p className="truncate font-mono text-xs text-foreground">{module.name}</p>
                                  <p className="font-mono text-[10px] text-muted-foreground">{module.groupName}</p>
                                </div>
                                <div className="flex items-center gap-1">
                                  <Button size="icon" variant="ghost" className="h-7 w-7 rounded-sm" onClick={() => changeQuantity(module.typeId, -1)}>
                                    <span className="font-mono text-sm">-</span>
                                  </Button>
                                  <span className="w-6 text-center font-mono text-xs">{module.quantity}</span>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 rounded-sm" onClick={() => changeQuantity(module.typeId, 1)}>
                                    <Plus className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button size="icon" variant="ghost" className="h-7 w-7 rounded-sm text-destructive hover:text-destructive" onClick={() => removeModule(module.typeId)}>
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="space-y-6">
              <Card className="bg-card/35 border-border/50 rounded-sm">
                <CardHeader className="border-b border-border/30 pb-4">
                  <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
                    <Gauge className="w-4 h-4 text-primary" />
                    {t("fitting.fitCheck")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  {simulate.isPending && (
                    <div className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin text-primary" />
                      {t("fitting.simulating")}
                    </div>
                  )}
                  {simulation && (
                    <>
                      <ResourceBar label="CPU" metric={simulation.resources.cpu} />
                      <ResourceBar label={t("fitting.powergrid")} metric={simulation.resources.powergrid} />
                      <ResourceBar label={t("fitting.calibration")} metric={simulation.resources.calibration} />
                      <div className="grid grid-cols-2 gap-3 pt-2 font-mono text-xs">
                        <div className="rounded-sm border border-border/40 p-3">
                          <Shield className="mb-2 h-4 w-4 text-primary" />
                          <p className="text-muted-foreground">{t("fitting.ehp")}</p>
                          <p className="mt-1 text-base font-bold">{numberLabel(simulation.defense.estimatedEhp)}</p>
                        </div>
                        <div className="rounded-sm border border-border/40 p-3">
                          <Zap className="mb-2 h-4 w-4 text-primary" />
                          <p className="text-muted-foreground">{t("fitting.capUse")}</p>
                          <p className="mt-1 text-base font-bold">{numberLabel(simulation.capacitor.activeCapUsePerSecond, 1)}/s</p>
                        </div>
                        <div className="rounded-sm border border-border/40 p-3">
                          <Target className="mb-2 h-4 w-4 text-primary" />
                          <p className="text-muted-foreground">{t("fitting.weapons")}</p>
                          <p className="mt-1 text-base font-bold">{simulation.offense.weaponCount}</p>
                        </div>
                        <div className="rounded-sm border border-border/40 p-3">
                          <Radar className="mb-2 h-4 w-4 text-primary" />
                          <p className="text-muted-foreground">{t("fitting.speed")}</p>
                          <p className="mt-1 text-base font-bold">{numberLabel(simulation.mobility.maxVelocity)} m/s</p>
                        </div>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card className="bg-card/35 border-border/50 rounded-sm">
                <CardHeader className="border-b border-border/30 pb-4">
                  <CardTitle className="text-sm font-mono tracking-wider uppercase flex items-center gap-2">
                    <Lightbulb className="w-4 h-4 text-primary" />
                    {t("fitting.advice")}
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-4">
                  {simulation ? (
                    <>
                      <div className="space-y-2">
                        {simulation.recommendations.map((item) => (
                          <div key={item} className="rounded-sm border border-primary/20 bg-primary/5 p-3 font-mono text-xs text-foreground">
                            {item}
                          </div>
                        ))}
                      </div>
                      <div className="space-y-2">
                        {simulation.limitations.map((item) => (
                          <div key={item} className="flex gap-2 rounded-sm border border-amber-500/25 bg-amber-500/5 p-3 font-mono text-xs text-muted-foreground">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
                            <span>{item}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="font-mono text-xs text-muted-foreground">{t("fitting.noSimulation")}</p>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
