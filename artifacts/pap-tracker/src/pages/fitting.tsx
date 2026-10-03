import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useGetMe } from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Copy,
  Database,
  Download,
  Gauge,
  Info,
  Layers3,
  Loader2,
  Plus,
  Redo2,
  Save,
  Search,
  Settings2,
  Shield,
  Ship,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import { fittingWorkbenchApi } from "@/lib/fitting-workbench-api";
import type {
  CanonicalFit,
  SavedFitting,
  WorkbenchCatalogItem,
  WorkbenchCategory,
  WorkbenchRack,
  WorkbenchSimulation,
  WorkbenchState,
} from "@/lib/fitting-workbench-types";
import {
  emptyFit,
  firstEmptySlot,
  fitKey,
  nextModuleState,
  parseLocalDraft,
  rackNames,
  rackOrder,
  stateNames,
  typeIcon,
} from "@/lib/fitting-workbench-presentation";
import {
  FIT_DRAG_TYPE,
  readFitDrag,
  SlotRing,
  type FitDrag,
} from "@/components/fitting-workbench/slot-ring";
import { StatsPanel } from "@/components/fitting-workbench/stats-panel";
import { FittingBays } from "@/components/fitting-workbench/bays";
import { FittingShipPreview } from "@/components/fitting-workbench/ship-preview";
import "@/components/fitting-workbench/workbench.css";

type Selection = { rack: WorkbenchRack; index: number };
type FitHistory = {
  past: CanonicalFit[];
  present: CanonicalFit;
  future: CanonicalFit[];
};
type ModalKind = "import" | "export" | "save" | "settings" | "newShip" | null;
type Bay = "drones" | "cargo" | "implants" | "boosters";
const itemCategories: Array<{
  category: WorkbenchCategory;
  zh: string;
  en: string;
}> = [
  { category: "module", zh: "装备", en: "Modules" },
  { category: "charge", zh: "弹药", en: "Charges" },
  { category: "drone", zh: "无人机", en: "Drones" },
  { category: "subsystem", zh: "子系统", en: "Subsystems" },
  { category: "fighter", zh: "铁骑舰载机", en: "Fighters" },
  { category: "implant", zh: "植入体", en: "Implants" },
  { category: "booster", zh: "增效剂", en: "Boosters" },
  { category: "cargo", zh: "货物", en: "Cargo" },
];
function IconButton({
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { children: ReactNode }) {
  return (
    <button type="button" className="fit-btn is-icon" {...props}>
      {children}
    </button>
  );
}

export function Fitting() {
  const { i18n } = useTranslation();
  const zh = i18n.language.startsWith("zh"),
    language = zh ? "zh" : "en";
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const { data: user } = useGetMe();
  const queryClient = useQueryClient();
  const accountRef = useRef(user?.id);
  accountRef.current = user?.id;
  const [history, setHistory] = useState<FitHistory>({
    past: [],
    present: emptyFit(),
    future: [],
  });
  const fit = history.present,
    key = fitKey(fit);
  const [debouncedFit, setDebouncedFit] = useState(fit);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [browserTab, setBrowserTab] = useState<"ships" | "hardware" | "saved">(
    "ships",
  );
  const [search, setSearch] = useState(""),
    [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState<WorkbenchCategory>("module");
  const [rackFilter, setRackFilter] = useState<WorkbenchRack | "all">("all");
  const [savedFilter, setSavedFilter] = useState<
    "all" | "personal" | "corporation"
  >("all");
  const [bay, setBay] = useState<Bay>("drones");
  const [mobilePanel, setMobilePanel] = useState<"browser" | "stats" | null>(
    null,
  );
  const [modal, setModal] = useState<ModalKind>(null);
  const [text, setText] = useState(""),
    [modalError, setModalError] = useState("");
  const [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    busyRef = useRef(false);
  const [saveVisibility, setSaveVisibility] = useState<
    "personal" | "corporation"
  >("personal");
  const [saveDescription, setSaveDescription] = useState("");
  const [loadedSaved, setLoadedSaved] = useState<SavedFitting | null>(null);
  const [pendingShip, setPendingShip] = useState<WorkbenchCatalogItem | null>(
    null,
  );
  const [draftReady, setDraftReady] = useState(false),
    draftLoadedKey = useRef("");
  const [draftSaved, setDraftSaved] = useState(false);
  const [catalogCache, setCatalogCache] = useState<
    Map<number, WorkbenchCatalogItem>
  >(new Map());
  const [lastSimulation, setLastSimulation] = useState<{
    key: string;
    result: WorkbenchSimulation;
  } | null>(null);
  const [settingsProfile, setSettingsProfile] = useState(fit.damageProfile);
  const [catalogHint, setCatalogHint] = useState(""),
    [bayAddQuantity, setBayAddQuantity] = useState(1);
  const [extraSaved, setExtraSaved] = useState<SavedFitting[]>([]);
  const [nextSavedCursor, setNextSavedCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const modalRef = useRef<HTMLElement>(null);
  const draftKey = user
    ? `eve-fitting-draft-v2:${user.id}:${user.corporationId ?? "primary"}`
    : null;
  const updateFit = (
    update: CanonicalFit | ((current: CanonicalFit) => CanonicalFit),
  ) => {
    setHistory((current) => {
      const next =
        typeof update === "function" ? update(current.present) : update;
      return fitKey(next) === fitKey(current.present)
        ? current
        : {
            past: [...current.past.slice(-79), current.present],
            present: next,
            future: [],
          };
    });
    setError("");
    setDraftSaved(false);
  };
  const undo = () =>
    setHistory((current) =>
      current.past.length
        ? {
            past: current.past.slice(0, -1),
            present: current.past[current.past.length - 1],
            future: [current.present, ...current.future],
          }
        : current,
    );
  const redo = () =>
    setHistory((current) =>
      current.future.length
        ? {
            past: [...current.past, current.present],
            present: current.future[0],
            future: current.future.slice(1),
          }
        : current,
    );
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedFit(fit), 160);
    return () => clearTimeout(timer);
  }, [key]);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 160);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    if (category === "drone" || category === "fighter")
      setBayAddQuantity((quantity) => Math.min(1000, quantity));
  }, [category]);
  useEffect(() => {
    if (!draftKey || draftLoadedKey.current === draftKey) return;
    const switchedAccount = draftLoadedKey.current !== "";
    draftLoadedKey.current = draftKey;
    let restored: CanonicalFit | null = null;
    try {
      restored = parseLocalDraft(localStorage.getItem(draftKey));
    } catch {
      /* Workbench still works when browser storage is unavailable. */
    }
    if (restored) {
      setHistory({ past: [], present: restored, future: [] });
      setNotice(
        tr(
          "已恢复此账号在本机的装配草稿。",
          "Restored this account's local fitting draft.",
        ),
      );
      setBrowserTab("hardware");
    } else if (switchedAccount) {
      setHistory({ past: [], present: emptyFit(), future: [] });
      setBrowserTab("ships");
      setNotice("");
    }
    setSelected(null);
    setLoadedSaved(null);
    setLastSimulation(null);
    setDraftReady(true);
  }, [draftKey]);
  useEffect(() => {
    if (!draftReady || !draftKey || !fit.shipTypeId) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, key);
        setDraftSaved(true);
      } catch {
        setDraftSaved(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [key, draftKey, draftReady]);

  const catalog = useQuery({
    queryKey: [
      "fittingWorkbench",
      "catalog",
      browserTab,
      debouncedSearch,
      category,
      rackFilter,
      language,
    ],
    queryFn: ({ signal }) =>
      fittingWorkbenchApi.catalog(
        {
          q: debouncedSearch,
          language,
          category: browserTab === "ships" ? "ship" : category,
          slot:
            browserTab === "hardware" && category === "module"
              ? rackFilter
              : "all",
          limit: 100,
        },
        signal,
      ),
    enabled: browserTab !== "saved",
    staleTime: 60_000,
  });
  const saved = useQuery({
    queryKey: ["fittingWorkbench", "saved", user?.id],
    queryFn: ({ signal }) => fittingWorkbenchApi.saved(signal),
    enabled: Boolean(user),
  });
  useEffect(() => {
    setExtraSaved([]);
    setNextSavedCursor(saved.data?.nextCursor ?? null);
  }, [saved.data]);
  const characters = useQuery({
    queryKey: ["fittingWorkbench", "characters", user?.id],
    queryFn: ({ signal }) => fittingWorkbenchApi.characters(signal),
    enabled: Boolean(user),
  });
  const simulationQuery = useQuery({
    queryKey: [
      "fittingWorkbench",
      "simulation",
      user?.id,
      fitKey(debouncedFit),
      language,
    ],
    queryFn: ({ signal }) =>
      fittingWorkbenchApi.simulate(debouncedFit, language, signal),
    enabled: debouncedFit.shipTypeId > 0 && draftReady,
    retry: false,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (simulationQuery.data && fitKey(debouncedFit) === key)
      setLastSimulation({ key, result: simulationQuery.data });
  }, [simulationQuery.data, key]);
  const simulation =
    lastSimulation?.result.fit.shipTypeId === fit.shipTypeId
      ? lastSimulation.result
      : undefined;
  const pending =
    fit.shipTypeId > 0 &&
    (lastSimulation?.key !== key || simulationQuery.isFetching);
  const simulationError = fitKey(debouncedFit) === key && simulationQuery.error;
  useEffect(() => {
    const items = [
      ...(catalog.data?.items ?? []),
      ...(simulation ? [simulation.ship, ...simulation.modules] : []),
    ];
    if (items.length)
      setCatalogCache((current) => {
        const next = new Map(current);
        for (const item of items) next.set(item.typeId, item);
        return next;
      });
  }, [catalog.data, simulation]);
  const fitTypeIds = useMemo(
    () =>
      [
        ...new Set([
          fit.shipTypeId,
          ...fit.slots.flatMap((entry) => [
            entry.typeId,
            entry.chargeTypeId ?? 0,
          ]),
          ...fit.drones.map((entry) => entry.typeId),
          ...fit.cargo.map((entry) => entry.typeId),
          ...(fit.implants ?? []).map((entry) => entry.typeId),
          ...(fit.boosters ?? []).map((entry) => entry.typeId),
        ]),
      ].filter((id) => id > 0),
    [key],
  );
  const fitCatalog = useQuery({
    queryKey: ["fittingWorkbench", "fit-types", fitTypeIds.join(","), language],
    queryFn: async ({ signal }) => {
      const chunks = Array.from(
        { length: Math.ceil(fitTypeIds.length / 100) },
        (_, index) => fitTypeIds.slice(index * 100, (index + 1) * 100),
      );
      const result = await Promise.all(
        chunks.map((ids) =>
          fittingWorkbenchApi.catalog(
            { typeIds: ids.join(","), language },
            signal,
          ),
        ),
      );
      return result.flatMap((chunk) => chunk.items);
    },
    enabled: fitTypeIds.length > 0,
    staleTime: 60_000,
  });
  const lookup = useMemo(
    () =>
      new Map([
        ...catalogCache,
        ...(fitCatalog.data ?? []).map(
          (item): [number, WorkbenchCatalogItem] => [item.typeId, item],
        ),
      ]),
    [catalogCache, fitCatalog.data],
  );
  const shipModeIds =
    lookup.get(fit.shipTypeId)?.capabilities?.modeTypeIds ?? [];
  const modeCatalog = useQuery({
    queryKey: ["fittingWorkbench", "modes", shipModeIds.join(","), language],
    queryFn: ({ signal }) =>
      fittingWorkbenchApi.catalog(
        { typeIds: shipModeIds.join(","), language },
        signal,
      ),
    enabled: shipModeIds.length > 0,
    staleTime: 60_000,
  });
  const selectedEntry = selected
    ? fit.slots.find(
        (slot) => slot.rack === selected.rack && slot.index === selected.index,
      )
    : undefined;
  const selectedItem = selectedEntry
    ? lookup.get(selectedEntry.typeId)
    : undefined;
  const selectedState = selected
    ? simulation?.moduleStates.find(
        (entry) =>
          entry.rack === selected.rack &&
          entry.index === selected.index &&
          entry.typeId === selectedEntry?.typeId,
      )
    : undefined;
  const canManageCorporation = saved.data?.canManageCorporation === true;
  const slotLimit = (rack: WorkbenchRack) => simulation?.slots[rack].limit ?? 0;
  const cacheItem = (item: WorkbenchCatalogItem) =>
    setCatalogCache((current) => new Map(current).set(item.typeId, item));
  const selectSlot = (rack: WorkbenchRack, index: number) => {
    setSelected({ rack, index });
    setBrowserTab("hardware");
    setCategory(rack === "subsystem" ? "subsystem" : "module");
    setRackFilter(rack);
    setSearch("");
  };
  const unfit = (rack: WorkbenchRack, index: number) =>
    updateFit((current) => ({
      ...current,
      slots: current.slots.filter(
        (entry) => entry.rack !== rack || entry.index !== index,
      ),
    }));
  const cycle = (rack: WorkbenchRack, index: number, reverse = false) => {
    const currentEntry = fit.slots.find(
      (entry) => entry.rack === rack && entry.index === index,
    );
    const maximum =
      simulation?.moduleStates.find(
        (entry) =>
          entry.rack === rack &&
          entry.index === index &&
          entry.typeId === currentEntry?.typeId,
      )?.maxState ??
      (currentEntry
        ? lookup.get(currentEntry.typeId)?.capabilities?.maxState
        : undefined);
    updateFit((current) => ({
      ...current,
      slots: current.slots.map((entry) =>
        entry.rack === rack && entry.index === index
          ? { ...entry, state: nextModuleState(entry.state, maximum, reverse) }
          : entry,
      ),
    }));
  };
  const addCargo = (item: WorkbenchCatalogItem, quantity = bayAddQuantity) => {
    const existing = fit.cargo.find((entry) => entry.typeId === item.typeId);
    if ((existing?.quantity ?? 0) + quantity > 1_000_000) {
      setError(
        tr(
          "此货物最多记录 1,000,000 件。",
          "Cargo quantity is limited to 1,000,000 per type.",
        ),
      );
      return;
    }
    cacheItem(item);
    setBay("cargo");
    updateFit((current) => {
      const existing = current.cargo.find(
        (entry) => entry.typeId === item.typeId,
      );
      return {
        ...current,
        cargo: existing
          ? current.cargo.map((entry) =>
              entry.typeId === item.typeId
                ? { ...entry, quantity: entry.quantity + quantity }
                : entry,
            )
          : [...current.cargo, { typeId: item.typeId, quantity }],
      };
    });
  };
  const activateShip = (item: WorkbenchCatalogItem) => {
    cacheItem(item);
    updateFit({
      ...emptyFit(item.typeId, item.name),
      skillProfile: fit.skillProfile,
      damageProfile: fit.damageProfile,
    });
    setSelected(null);
    setLoadedSaved(null);
    setBrowserTab("hardware");
    setSearch("");
    setRackFilter("all");
    setModal(null);
    setPendingShip(null);
  };
  const chooseShip = (item: WorkbenchCatalogItem) => {
    if (fit.shipTypeId === item.typeId) {
      setBrowserTab("hardware");
      return;
    }
    if (
      fit.slots.length ||
      fit.drones.length ||
      fit.cargo.length ||
      (fit.implants?.length ?? 0) ||
      (fit.boosters?.length ?? 0)
    ) {
      setPendingShip(item);
      setModalError("");
      setModal("newShip");
      return;
    }
    activateShip(item);
  };
  const install = (item: WorkbenchCatalogItem, destination?: Selection) => {
    setError("");
    cacheItem(item);
    if (item.category === "ship") {
      chooseShip(item);
      return;
    }
    if (!fit.shipTypeId) {
      setError(tr("请先选择舰船。", "Select a ship first."));
      return;
    }
    if (item.category === "charge") {
      const target = destination ?? selected;
      if (
        !target ||
        !fit.slots.some(
          (entry) => entry.rack === target.rack && entry.index === target.index,
        )
      ) {
        addCargo(item);
        setNotice(
          tr(
            "弹药已放入货舱；选择武器槽位后可以装填。",
            "Charge added to cargo. Select a weapon slot to load it.",
          ),
        );
        return;
      }
      updateFit((current) => ({
        ...current,
        slots: current.slots.map((entry) =>
          entry.rack === target.rack && entry.index === target.index
            ? { ...entry, chargeTypeId: item.typeId, chargeQuantity: undefined }
            : entry,
        ),
      }));
      return;
    }
    if (item.category === "drone" || item.category === "fighter") {
      const existing = fit.drones.find((entry) => entry.typeId === item.typeId);
      if ((existing?.quantity ?? 0) + bayAddQuantity > 1000) {
        setError(
          tr(
            "每种无人机或舰载机最多记录 1,000 架。",
            "Drone or fighter quantity is limited to 1,000 per type.",
          ),
        );
        return;
      }
      setBay("drones");
      updateFit((current) => {
        const existing = current.drones.find(
          (entry) => entry.typeId === item.typeId,
        );
        return {
          ...current,
          drones: existing
            ? current.drones.map((entry) =>
                entry.typeId === item.typeId
                  ? { ...entry, quantity: entry.quantity + bayAddQuantity }
                  : entry,
              )
            : [
                ...current.drones,
                {
                  typeId: item.typeId,
                  quantity: bayAddQuantity,
                  activeQuantity: 0,
                },
              ],
        };
      });
      return;
    }
    if (item.category === "implant" || item.category === "booster") {
      const field = item.category === "implant" ? "implants" : "boosters";
      setBay(field);
      updateFit((current) => ({
        ...current,
        [field]: (current[field] ?? []).some(
          (entry) => entry.typeId === item.typeId,
        )
          ? current[field]
          : [...(current[field] ?? []), { typeId: item.typeId }],
      }));
      return;
    }
    if (!rackOrder.includes(item.slot as WorkbenchRack)) {
      addCargo(item);
      return;
    }
    const rack = item.slot as WorkbenchRack,
      target =
        destination ??
        (selected?.rack === rack &&
        !fit.slots.some(
          (entry) =>
            entry.rack === selected.rack && entry.index === selected.index,
        )
          ? selected
          : null);
    if (target && target.rack !== rack) {
      setError(
        tr("此装备不适用于选中的槽位。", "This module does not fit that rack."),
      );
      return;
    }
    const limit = slotLimit(rack);
    if (!limit) {
      setError(
        tr(
          "当前舰船没有可用的此类槽位。",
          "This hull has no available slots in this rack.",
        ),
      );
      return;
    }
    const index = target?.index ?? firstEmptySlot(fit, rack, limit);
    if (index === null || index >= limit) {
      setError(
        tr(
          "此类槽位已满，请先卸载装备或选择一个槽位替换。",
          "Rack is full. Unfit a module or select a slot to replace it.",
        ),
      );
      return;
    }
    updateFit((current) => ({
      ...current,
      slots: [
        ...current.slots.filter(
          (entry) => entry.rack !== rack || entry.index !== index,
        ),
        { rack, index, typeId: item.typeId, state: "online" },
      ],
    }));
    setSelected({ rack, index });
    setBrowserTab("hardware");
  };
  const drop = (
    data: FitDrag,
    rack?: WorkbenchRack,
    index?: number,
    duplicate = false,
  ) => {
    if (data.kind === "catalog") {
      install(
        data.item,
        rack === undefined || index === undefined ? undefined : { rack, index },
      );
      return;
    }
    const source = fit.slots.find(
      (entry) => entry.rack === data.rack && entry.index === data.index,
    );
    if (
      !source ||
      rack === undefined ||
      index === undefined ||
      source.index === index
    )
      return;
    if (rack !== source.rack) {
      setError(
        tr(
          "只能在相同类型槽位之间移动装备。",
          "Move modules within the same rack.",
        ),
      );
      return;
    }
    if (index >= slotLimit(rack)) return;
    const destination = fit.slots.find(
      (entry) => entry.rack === rack && entry.index === index,
    );
    if (duplicate && destination) {
      setError(
        tr("复制装备需要一个空槽位。", "Duplicate modules into an empty slot."),
      );
      return;
    }
    updateFit((current) => ({
      ...current,
      slots: [
        ...current.slots.filter(
          (entry) =>
            !(
              entry.rack === rack &&
              (entry.index === index ||
                (!duplicate && entry.index === source.index))
            ),
        ),
        { ...source, index },
        ...(!duplicate && destination
          ? [{ ...destination, index: source.index }]
          : []),
      ],
    }));
    setSelected({ rack, index });
  };
  const loadSaved = (entry: SavedFitting) => {
    if (entry.fit.skillProfile.mode === "character" && characters.isPending) {
      setError(
        tr(
          "正在读取本人角色，请稍后再载入。",
          "Your characters are still loading. Please try again shortly.",
        ),
      );
      return;
    }
    const foreignCharacter =
      entry.fit.skillProfile.mode === "character" &&
      !characters.data?.characters.some(
        (character) => character.id === entry.fit.skillProfile.characterId,
      );
    const profile = foreignCharacter
      ? { mode: "all5" as const }
      : entry.fit.skillProfile;
    updateFit({ ...entry.fit, name: entry.name, skillProfile: profile });
    setLoadedSaved(entry);
    setSaveDescription(entry.description);
    setSelected(null);
    setNotice(
      tr(
        `已载入${entry.visibility === "corporation" ? "军团" : "个人"}配置。${foreignCharacter ? "已使用全 V 技能（原作者角色不可读取）。" : ""}`,
        `Loaded ${entry.visibility} fitting.${foreignCharacter ? " Using all V skills because the author's character is not available to this account." : ""}`,
      ),
    );
  };
  const runAction = async (operation: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setModalError("");
    try {
      await operation();
    } catch (caught) {
      setModalError(
        caught instanceof Error
          ? caught.message
          : tr("操作失败，请重试。", "Request failed. Please retry."),
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const showImport = () => {
    setText("");
    setModalError("");
    setModal("import");
  };
  const showExport = () => {
    setText("");
    setModalError("");
    setModal("export");
    void runAction(async () => {
      const result = await fittingWorkbenchApi.export(fit, language);
      setText(result.text);
      if (result.warnings.length) setModalError(result.warnings.join("\n"));
    });
  };
  const showSave = () => {
    setSaveVisibility(
      loadedSaved?.visibility === "corporation" && canManageCorporation
        ? "corporation"
        : "personal",
    );
    setSaveDescription(loadedSaved?.description ?? "");
    setModalError("");
    setModal("save");
  };
  const saveFit = (replace: boolean) =>
    void runAction(async () => {
      if (!fit.name.trim()) {
        setModalError(tr("请填写配置名称。", "Enter a fitting name."));
        return;
      }
      const body = { name: fit.name.trim(), description: saveDescription, fit };
      const result =
        replace && loadedSaved
          ? await fittingWorkbenchApi.update(loadedSaved.id, {
              ...body,
              version: loadedSaved.version,
            })
          : await fittingWorkbenchApi.create({
              ...body,
              visibility: saveVisibility,
            });
      setLoadedSaved(result.fitting);
      setNotice(tr("配置已保存。", "Fitting saved."));
      setModal(null);
      await queryClient.invalidateQueries({
        queryKey: ["fittingWorkbench", "saved"],
      });
    });
  const errorMessage =
    error || (simulationError instanceof Error ? simulationError.message : "");
  const visibleSaved = [...(saved.data?.fittings ?? []), ...extraSaved].filter(
    (entry) =>
      (savedFilter === "all" || savedFilter === entry.visibility) &&
      (!search ||
        `${entry.name} ${entry.authorName}`
          .toLocaleLowerCase()
          .includes(search.toLocaleLowerCase())),
  );
  const loadMoreSaved = async () => {
    if (loadingMore || nextSavedCursor === null) return;
    const requestAccount = user?.id;
    setLoadingMore(true);
    try {
      const result = await fittingWorkbenchApi.saved(
        undefined,
        nextSavedCursor,
      );
      if (accountRef.current !== requestAccount) return;
      setExtraSaved((entries) => [...entries, ...result.fittings]);
      setNextSavedCursor(result.nextCursor);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : tr("读取失败", "Could not load fittings"),
      );
    } finally {
      setLoadingMore(false);
    }
  };
  useEffect(() => {
    if (!modal) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const first = modalRef.current?.querySelector<HTMLElement>(
      "textarea, input, select, button",
    );
    first?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        setModal(null);
      }
      if (event.key === "Tab") {
        const elements = Array.from(
          modalRef.current?.querySelectorAll<HTMLElement>(
            "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex='0']",
          ) ?? [],
        ).filter((element) => element.getClientRects().length > 0);
        const first = elements[0],
          last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first && last) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          document.activeElement === last &&
          first
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previous?.focus();
    };
  }, [modal]);

  return (
    <div className="fitting-workbench">
      <div className="fit-window">
        <div className="fit-toolbar">
          <div className="fit-toolbar-title">
            <Ship size={19} />
            <div>
              <strong>{tr("舰船模拟装配", "Fitting simulation")}</strong>
              <small>
                {tr(
                  "选择舰船 · 装配装备 · 即时计算属性",
                  "Select a hull · fit modules · inspect live stats",
                )}
              </small>
            </div>
          </div>
          <IconButton
            title={tr("撤销", "Undo")}
            aria-label={tr("撤销", "Undo")}
            onClick={undo}
            disabled={!history.past.length}
          >
            <Undo2 size={14} />
          </IconButton>
          <IconButton
            title={tr("重做", "Redo")}
            aria-label={tr("重做", "Redo")}
            onClick={redo}
            disabled={!history.future.length}
          >
            <Redo2 size={14} />
          </IconButton>
          <button className="fit-btn" onClick={showImport}>
            <Upload size={13} />
            {tr("导入配置", "Import")}
          </button>
          <button
            className="fit-btn"
            disabled={!fit.shipTypeId || busy}
            onClick={showExport}
          >
            <Download size={13} />
            {tr("导出", "Export")}
          </button>
          <button
            className="fit-btn is-primary"
            disabled={!fit.shipTypeId || pending || busy || !!simulationError}
            onClick={showSave}
          >
            <Save size={13} />
            {tr("保存配置", "Save fitting")}
          </button>
        </div>
        {notice && (
          <div className="fit-bottom-bar">
            <Check size={13} />
            <span className="fit-history-label">{notice}</span>
            <IconButton
              aria-label={tr("关闭提示", "Dismiss notice")}
              onClick={() => setNotice("")}
            >
              <X size={12} />
            </IconButton>
          </div>
        )}
        {errorMessage && (
          <div className="fit-error" role="alert">
            <AlertTriangle size={13} />
            <span>{errorMessage}</span>
            <button
              className="fit-btn is-small"
              onClick={() => {
                setError("");
                void simulationQuery.refetch();
              }}
            >
              {tr("重新计算", "Retry")}
            </button>
          </div>
        )}
        <div className="fit-mobile-controls">
          <button
            className={`fit-btn ${mobilePanel === "browser" ? "is-active" : ""}`}
            onClick={() =>
              setMobilePanel(mobilePanel === "browser" ? null : "browser")
            }
          >
            <Database size={13} />
            {tr("装备浏览器", "Browser")}
          </button>
          <button
            className={`fit-btn ${mobilePanel === "stats" ? "is-active" : ""}`}
            onClick={() =>
              setMobilePanel(mobilePanel === "stats" ? null : "stats")
            }
          >
            <Gauge size={13} />
            {tr("舰船属性", "Attributes")}
          </button>
        </div>
        <div className="fit-main-grid">
          <aside
            className={`fit-browser ${mobilePanel === "browser" ? "is-mobile-open" : ""}`}
            aria-label={tr("装配浏览器", "Fitting browser")}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(FIT_DRAG_TYPE))
                event.preventDefault();
            }}
            onDrop={(event) => {
              const data = readFitDrag(event);
              if (data?.kind === "slot") {
                event.preventDefault();
                unfit(data.rack, data.index);
              }
            }}
          >
            <div className="fit-browser-tabs">
              {(["ships", "hardware", "saved"] as const).map((tab, index) => (
                <button
                  key={tab}
                  type="button"
                  className={browserTab === tab ? "is-active" : ""}
                  onClick={() => {
                    setBrowserTab(tab);
                    setSearch("");
                  }}
                >
                  {
                    [
                      tr("舰船", "Hulls"),
                      tr("装备", "Hardware"),
                      tr("配置", "Fits"),
                    ][index]
                  }
                </button>
              ))}
            </div>
            <div className="fit-browser-search">
              <div className="fit-search-field">
                <Search size={13} />
                <input
                  className="fit-input"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={
                    browserTab === "ships"
                      ? tr("搜索舰船，中英文均可", "Search hulls, EN / 中文")
                      : browserTab === "saved"
                        ? tr("搜索已保存配置", "Search saved fittings")
                        : tr("搜索装备或弹药", "Search modules or charges")
                  }
                  aria-label={tr("搜索装配数据库", "Search fitting database")}
                />
              </div>
              {browserTab === "hardware" && (
                <>
                  <div className="fit-browser-category">
                    {itemCategories.map((item) => (
                      <button
                        key={item.category}
                        className={`fit-btn is-small ${category === item.category ? "is-active" : ""}`}
                        onClick={() => {
                          setCategory(item.category);
                          setSearch("");
                        }}
                      >
                        {zh ? item.zh : item.en}
                      </button>
                    ))}
                  </div>
                  {(category === "module" || category === "subsystem") && (
                    <div className="fit-browser-filters">
                      {(["all", ...rackOrder] as const).map((rack) => (
                        <button
                          key={rack}
                          className={`fit-btn is-small ${rackFilter === rack ? "is-active" : ""}`}
                          onClick={() => setRackFilter(rack)}
                        >
                          {rack === "all"
                            ? tr("全部槽位", "All racks")
                            : rackNames[rack][zh ? 0 : 1]}
                        </button>
                      ))}
                    </div>
                  )}
                  {["drone", "fighter", "charge", "cargo"].includes(
                    category,
                  ) && (
                    <label
                      className="fit-bay-summary"
                      style={{ marginTop: 10 }}
                    >
                      {tr("每次添加", "Add quantity")}
                      <input
                        aria-label={tr("每次添加数量", "Quantity to add")}
                        type="number"
                        className="fit-input"
                        style={{ width: 60, padding: "3px 5px" }}
                        min={1}
                        max={
                          category === "charge" || category === "cargo"
                            ? 1_000_000
                            : 1000
                        }
                        value={Math.min(
                          bayAddQuantity,
                          category === "charge" || category === "cargo"
                            ? 1_000_000
                            : 1000,
                        )}
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (
                            Number.isSafeInteger(value) &&
                            value > 0 &&
                            value <=
                              (category === "charge" || category === "cargo"
                                ? 1_000_000
                                : 1000)
                          )
                            setBayAddQuantity(value);
                        }}
                      />
                    </label>
                  )}
                </>
              )}
              {browserTab === "saved" && (
                <div className="fit-browser-filters">
                  {(["all", "personal", "corporation"] as const).map(
                    (visibility, index) => (
                      <button
                        key={visibility}
                        className={`fit-btn is-small ${savedFilter === visibility ? "is-active" : ""}`}
                        onClick={() => setSavedFilter(visibility)}
                      >
                        {
                          [
                            tr("全部", "All"),
                            tr("个人", "Personal"),
                            tr("军团", "Corporation"),
                          ][index]
                        }
                      </button>
                    ),
                  )}
                </div>
              )}
            </div>
            <div className="fit-browser-list">
              {browserTab === "saved" ? (
                <>
                  {saved.isLoading && (
                    <div className="fit-loading">
                      <Loader2 className="fit-refresh-icon" size={15} />
                      {tr("正在读取配置", "Loading fittings")}
                    </div>
                  )}
                  {saved.error && (
                    <div className="fit-error">
                      {saved.error instanceof Error
                        ? saved.error.message
                        : tr("读取失败", "Could not load fittings")}
                    </div>
                  )}
                  {visibleSaved.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      className="fit-fit-row"
                      onClick={() => loadSaved(entry)}
                    >
                      <img src={typeIcon(entry.fit.shipTypeId)} alt="" />
                      <div>
                        <strong>{entry.name}</strong>
                        <small>
                          {entry.authorName} ·{" "}
                          {entry.description || tr("无说明", "No description")}
                        </small>
                      </div>
                      <span>
                        {entry.visibility === "corporation"
                          ? tr("军团", "Corp")
                          : tr("个人", "Personal")}
                      </span>
                    </button>
                  ))}
                  {nextSavedCursor !== null && (
                    <button
                      className="fit-btn"
                      style={{ margin: 10 }}
                      disabled={loadingMore}
                      onClick={() => void loadMoreSaved()}
                    >
                      {loadingMore && (
                        <Loader2 className="fit-refresh-icon" size={12} />
                      )}{" "}
                      {tr("加载更多配置", "Load more fittings")}
                    </button>
                  )}
                  {!saved.isLoading && !visibleSaved.length && (
                    <p className="fit-empty">
                      {tr(
                        "没有匹配的配置。装配完成后可保存为个人或军团配置。",
                        "No fittings found. Save a fit for yourself or your corporation.",
                      )}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {catalog.isFetching && (
                    <div className="fit-loading">
                      <Loader2 className="fit-refresh-icon" size={14} />
                      {tr("正在搜索", "Searching")}
                    </div>
                  )}
                  {catalog.error && (
                    <div className="fit-error">
                      {catalog.error instanceof Error
                        ? catalog.error.message
                        : tr("搜索失败", "Search failed")}
                    </div>
                  )}
                  {catalog.data?.items.map((item) => (
                    <div
                      key={item.typeId}
                      role="button"
                      tabIndex={0}
                      className={`fit-catalog-row ${fit.shipTypeId === item.typeId ? "is-selected" : ""}`}
                      title={`${item.name}\n${item.nameEn}\n${item.groupName}`}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          FIT_DRAG_TYPE,
                          JSON.stringify({ kind: "catalog", item }),
                        );
                        event.dataTransfer.effectAllowed = "copy";
                      }}
                      onClick={() => setCatalogHint(item.name)}
                      onDoubleClick={() => install(item)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") install(item);
                      }}
                    >
                      <img src={typeIcon(item.typeId)} alt="" />
                      <span>
                        <strong>{item.name}</strong>
                        <small>{item.groupName}</small>
                      </span>
                      <button
                        type="button"
                        className="fit-btn is-small is-icon"
                        aria-label={`${item.category === "ship" ? tr("模拟", "Simulate") : tr("安装", "Fit")} ${item.name}`}
                        title={
                          item.category === "ship"
                            ? tr("模拟此舰船", "Simulate this hull")
                            : item.category === "charge"
                              ? tr(
                                  "装填到选中槽位；未选槽位则放入货舱",
                                  "Load selected slot, or add to cargo",
                                )
                              : tr("安装此装备", "Fit this item")
                        }
                        onClick={(event) => {
                          event.stopPropagation();
                          install(item);
                        }}
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  ))}
                  {!catalog.isFetching && !catalog.data?.items.length && (
                    <p className="fit-empty">
                      {tr(
                        "未找到匹配物品，请尝试其他名称。",
                        "No matches. Try another name.",
                      )}
                    </p>
                  )}
                </>
              )}
            </div>
            <div className="fit-browser-hint">
              {catalogHint && (
                <strong style={{ display: "block", marginBottom: 4 }}>
                  {catalogHint}
                </strong>
              )}
              {tr(
                "双击或拖动装备到槽位。拖回此栏可卸载。Shift 拖动可复制到空槽。",
                "Double-click or drag items to a slot. Drag back here to unfit. Shift-drag duplicates into an empty slot.",
              )}
            </div>
          </aside>
          <main className="fit-center">
            <div className="fit-simulation-head">
              <input
                className="fit-input"
                value={fit.name}
                maxLength={100}
                aria-label={tr("配置名称", "Fitting name")}
                placeholder={tr("配置名称", "Fitting name")}
                onChange={(event) =>
                  updateFit((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
              />
              <select
                className="fit-select fit-skill-select"
                aria-label={tr("技能模式", "Skill profile")}
                value={
                  fit.skillProfile.mode === "character"
                    ? `character:${fit.skillProfile.characterId}`
                    : fit.skillProfile.mode
                }
                onChange={(event) => {
                  const value = event.target.value;
                  updateFit((current) => ({
                    ...current,
                    skillProfile: value.startsWith("character:")
                      ? {
                          mode: "character",
                          characterId: Number(value.split(":")[1]),
                        }
                      : { mode: value as "all5" | "none" },
                  }));
                }}
              >
                <option value="all5">{tr("全部技能 V", "All skills V")}</option>
                <option value="none">{tr("无技能", "No skills")}</option>
                {characters.data?.characters.map((character) => (
                  <option
                    key={character.id}
                    value={`character:${character.id}`}
                  >
                    {character.name}
                    {character.isMain ? tr("（主角色）", " (main)") : ""}
                  </option>
                ))}
              </select>
              <IconButton
                title={tr("伤害模型设置", "Damage profile settings")}
                aria-label={tr("伤害模型设置", "Damage profile settings")}
                onClick={() => {
                  setSettingsProfile({ ...fit.damageProfile });
                  setModalError("");
                  setModal("settings");
                }}
              >
                <Settings2 size={14} />
              </IconButton>
            </div>
            <SlotRing
              fit={fit}
              preview={
                fit.shipTypeId ? <FittingShipPreview fit={fit} /> : undefined
              }
              simulation={simulation}
              lookup={lookup}
              selected={selected}
              onSelect={selectSlot}
              onCycle={cycle}
              onDrop={drop}
              onUnfit={unfit}
              zh={zh}
            />
            {shipModeIds.length > 0 && (
              <div
                className="fit-selected-controls"
                style={{ justifyContent: "center", marginBottom: 12 }}
                aria-label={tr("战术模式", "Tactical mode")}
              >
                {modeCatalog.data?.items.map((mode) => (
                  <button
                    key={mode.typeId}
                    className={`fit-btn is-small ${(fit.modeTypeId ?? simulation?.fit.modeTypeId) === mode.typeId ? "is-active" : ""}`}
                    onClick={() =>
                      updateFit((current) => ({
                        ...current,
                        modeTypeId: mode.typeId,
                      }))
                    }
                  >
                    {mode.name}
                  </button>
                ))}
              </div>
            )}
            {selected && (
              <div className="fit-selected-slot">
                <div className="fit-selected-title">
                  {selectedEntry && (
                    <img src={typeIcon(selectedEntry.typeId)} alt="" />
                  )}
                  <div>
                    <strong>
                      {rackNames[selected.rack][zh ? 0 : 1]}{" "}
                      {selected.index + 1} ·{" "}
                      {selectedItem?.name ??
                        (selectedEntry
                          ? `#${selectedEntry.typeId}`
                          : tr("空槽", "Empty slot"))}
                    </strong>
                    <small>
                      {selectedEntry
                        ? tr(
                            "为此件装备单独调整状态和弹药。",
                            "Adjust this module's state and loaded charge.",
                          )
                        : tr(
                            "从左侧选择适用装备，双击或拖入此槽。",
                            "Choose a matching module and double-click or drag it here.",
                          )}
                    </small>
                  </div>
                  <IconButton
                    aria-label={tr("关闭槽位详情", "Close slot details")}
                    onClick={() => setSelected(null)}
                  >
                    <X size={12} />
                  </IconButton>
                </div>
                {selectedEntry && (
                  <>
                    <div className="fit-selected-controls">
                      <select
                        className="fit-select"
                        aria-label={tr("模块状态", "Module state")}
                        value={selectedState?.state ?? selectedEntry.state}
                        onChange={(event) =>
                          updateFit((current) => ({
                            ...current,
                            slots: current.slots.map((entry) =>
                              entry.rack === selected.rack &&
                              entry.index === selected.index
                                ? {
                                    ...entry,
                                    state: event.target.value as WorkbenchState,
                                  }
                                : entry,
                            ),
                          }))
                        }
                      >
                        {(
                          ["offline", "online", "active", "overheated"] as const
                        )
                          .filter(
                            (state, index) =>
                              index <=
                              (
                                [
                                  "offline",
                                  "online",
                                  "active",
                                  "overheated",
                                ] as const
                              ).indexOf(
                                selectedState?.maxState ?? "overheated",
                              ),
                          )
                          .map((state) => (
                            <option value={state} key={state}>
                              {stateNames[state][zh ? 0 : 1]}
                            </option>
                          ))}
                      </select>
                      <button
                        className="fit-btn is-small"
                        onClick={() => {
                          setCategory("charge");
                          setSearch("");
                          setBrowserTab("hardware");
                          setMobilePanel("browser");
                        }}
                      >
                        <Layers3 size={12} />
                        {tr("选择弹药", "Choose charge")}
                      </button>
                      <button
                        className="fit-btn is-small is-danger"
                        onClick={() => unfit(selected.rack, selected.index)}
                      >
                        <Trash2 size={12} />
                        {tr("卸载", "Unfit")}
                      </button>
                    </div>
                    <div className="fit-charge-controls">
                      {selectedEntry.chargeTypeId ? (
                        <>
                          <img
                            src={typeIcon(selectedEntry.chargeTypeId)}
                            alt=""
                          />
                          <span>
                            {lookup.get(selectedEntry.chargeTypeId)?.name ??
                              `#${selectedEntry.chargeTypeId}`}
                            <small>
                              {tr(
                                "装填到此装备 · 按满装弹仓计算",
                                "Loaded in this module · full magazine calculation",
                              )}
                            </small>
                          </span>
                          <button
                            className="fit-btn is-small"
                            onClick={() =>
                              updateFit((current) => ({
                                ...current,
                                slots: current.slots.map((entry) =>
                                  entry.rack === selected.rack &&
                                  entry.index === selected.index
                                    ? {
                                        ...entry,
                                        chargeTypeId: undefined,
                                        chargeQuantity: undefined,
                                      }
                                    : entry,
                                ),
                              }))
                            }
                          >
                            {tr("卸弹", "Unload")}
                          </button>
                        </>
                      ) : (
                        <span>
                          {tr(
                            "尚未装填弹药。武器、脚本和电容注电器需选择兼容弹药。",
                            "No charge loaded. Weapons, scripts and cap boosters need compatible charges.",
                          )}
                        </span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            <FittingBays
              fit={fit}
              simulation={simulation}
              lookup={lookup}
              bay={bay}
              setBay={setBay}
              updateFit={updateFit}
              tr={tr}
              onDropItem={(item) =>
                bay === "cargo" ? addCargo(item) : install(item)
              }
            />
            <div className="fit-bottom-bar">
              <span className="fit-history-label">
                {pending ? (
                  <>
                    <Loader2
                      className="fit-refresh-icon"
                      size={11}
                      style={{ display: "inline", marginRight: 4 }}
                    />
                    {tr("正在更新装配属性…", "Updating fitting stats…")}
                  </>
                ) : simulation ? (
                  simulation.valid ? (
                    tr("装配检查通过", "Fit checks passed")
                  ) : (
                    tr(
                      "装配存在限制，详情见下方",
                      "Fit has restrictions; see below",
                    )
                  )
                ) : (
                  tr("选择舰船开始模拟", "Choose a hull to start")
                )}
              </span>
              <span className="fit-draft-status">
                {draftSaved
                  ? tr("草稿已保存在本机", "Draft saved locally")
                  : ""}
              </span>
            </div>
            {simulation && (
              <>
                {simulation.violations.length ||
                simulation.limitations.length ? (
                  <details
                    className="fit-validation"
                    open={simulation.violations.length > 0}
                  >
                    <summary>
                      <AlertTriangle size={12} />
                      {tr(
                        "装配警告与计算范围",
                        "Fit warnings & calculation scope",
                      )}{" "}
                      (
                      {simulation.violations.length +
                        simulation.limitations.length}
                      )
                    </summary>
                    {simulation.violations.map((violation, index) => (
                      <p key={`v:${index}`}>{violation.message}</p>
                    ))}
                    {simulation.limitations.map((limitation, index) => (
                      <p key={`l:${index}`}>{limitation}</p>
                    ))}
                  </details>
                ) : (
                  <div className="fit-validation fit-valid-label">
                    <Shield size={12} />
                    {tr(
                      "槽位、资源与装备限制检查通过。",
                      "Slots, resources and module restrictions passed.",
                    )}
                  </div>
                )}
              </>
            )}
          </main>
          <div
            className={`fit-property-wrapper ${mobilePanel === "stats" ? "is-mobile-open" : ""}`}
          >
            <StatsPanel simulation={simulation} tr={tr} pending={pending} />
          </div>
        </div>
      </div>
      <div className="fit-precision-note">
        <Info size={12} />
        <span>
          {simulation
            ? `${simulation.engine.name} · SDE ${simulation.sdeBuildNumber} · ${fit.skillProfile.mode === "all5" ? tr("全部技能 V", "All skills V") : fit.skillProfile.mode === "none" ? tr("无技能", "No skills") : tr("本人角色技能", "Your character skills")}`
            : tr(
                "以 EVE 静态数据与 Dogma 效果计算装配属性。",
                "Fitting attributes use EVE static data and Dogma effects.",
              )}
        </span>
        {simulation?.engine.note && (
          <details>
            <summary>{tr("计算说明", "Calculation details")}</summary>
            <p>{simulation.engine.note}</p>
          </details>
        )}
      </div>
      <p className="fit-license-note">
        {tr(
          "EVE Online 舰船模型和游戏数据版权归 CCP hf.。本工具为非官方军团工具，与 CCP 无关联或背书。",
          "EVE Online ship models and game data are copyright CCP hf. This is an unofficial corporation tool and is not affiliated with or endorsed by CCP.",
        )}{" "}
        <a
          href="https://developers.eveonline.com/license-agreement"
          target="_blank"
          rel="noopener noreferrer"
        >
          {tr("官方许可协议", "Official license agreement")}
        </a>
      </p>
      {modal && (
        <div
          className="fit-modal-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setModal(null);
          }}
        >
          <section
            ref={modalRef}
            className="fit-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="fit-modal-title"
          >
            <div className="fit-modal-header">
              <strong id="fit-modal-title">
                {modal === "import"
                  ? tr("导入游戏装配文本", "Import fitting text")
                  : modal === "export"
                    ? tr("导出游戏装配文本", "Export fitting text")
                    : modal === "save"
                      ? tr("保存装配配置", "Save fitting")
                      : modal === "settings"
                        ? tr("模拟伤害模型", "Incoming damage profile")
                        : tr("更换模拟舰船", "Change simulated hull")}
              </strong>
              <IconButton
                aria-label={tr("关闭窗口", "Close dialog")}
                disabled={busy}
                onClick={() => setModal(null)}
              >
                <X size={14} />
              </IconButton>
            </div>
            <div className="fit-modal-body">
              {modalError && (
                <div
                  className="fit-error"
                  role="alert"
                  style={{ whiteSpace: "pre-line" }}
                >
                  {modalError}
                </div>
              )}
              {(modal === "import" || modal === "export") && (
                <>
                  <p>
                    {modal === "import"
                      ? tr(
                          "可直接粘贴游戏内复制的装配或 EFT 文本。导入会保留当前草稿到撤销历史。",
                          "Paste a fitting copied from EVE or an EFT fit. The current fit remains in undo history.",
                        )
                      : tr(
                          "复制后可在 EVE 装配窗口的“导入 / 导出”中粘贴。EFT 文本不保存模块启用状态；网页保存会保留完整模拟。",
                          "Paste this into EVE's fitting Import / Export. EFT does not store module activation states; saved website fittings preserve the full simulation.",
                        )}
                  </p>
                  <textarea
                    className="fit-textarea"
                    aria-label={
                      modal === "import"
                        ? tr("待导入配置文本", "Fitting text to import")
                        : tr("导出的 EFT 配置", "Exported EFT fitting")
                    }
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                    readOnly={modal === "export"}
                    placeholder={
                      "[Tristan, My fit]\nDamage Control II\n\n1MN Afterburner II\n\n..."
                    }
                  />
                </>
              )}
              {modal === "save" && (
                <>
                  <label>
                    {tr("配置名称", "Fitting name")}
                    <input
                      className="fit-input"
                      value={fit.name}
                      maxLength={100}
                      onChange={(event) =>
                        updateFit((current) => ({
                          ...current,
                          name: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    {tr("配置说明", "Description")}
                    <textarea
                      className="fit-textarea fit-description"
                      maxLength={2000}
                      value={saveDescription}
                      onChange={(event) =>
                        setSaveDescription(event.target.value)
                      }
                    />
                  </label>
                  <label>
                    {tr("保存位置", "Visibility")}
                    <select
                      className="fit-select"
                      value={saveVisibility}
                      onChange={(event) =>
                        setSaveVisibility(
                          event.target.value as "personal" | "corporation",
                        )
                      }
                    >
                      <option value="personal">
                        {tr(
                          "个人配置，仅自己可见",
                          "Personal, visible only to you",
                        )}
                      </option>
                      {canManageCorporation && (
                        <option value="corporation">
                          {tr(
                            "军团配置，全军团成员可见",
                            "Corporation, visible to members",
                          )}
                        </option>
                      )}
                    </select>
                  </label>
                  {loadedSaved && (
                    <p>
                      {tr(
                        `当前载入：${loadedSaved.name}。可以另存副本${loadedSaved.canEdit ? "，也可以更新原配置" : ""}。`,
                        `Loaded: ${loadedSaved.name}. Save a copy${loadedSaved.canEdit ? " or update the original" : ""}.`,
                      )}
                    </p>
                  )}
                </>
              )}
              {modal === "settings" && (
                <>
                  <p>
                    {tr(
                      "设置承受伤害的比例。总和不必为 100，计算时会自动归一化；该模型影响有效生命与有效维修。",
                      "Set incoming damage proportions. Values are normalized and affect EHP and effective repair.",
                    )}
                  </p>
                  <div className="fit-damage-fields">
                    {(["em", "thermal", "kinetic", "explosive"] as const).map(
                      (damage, index) => (
                        <label className={`damage-${damage}`} key={damage}>
                          {
                            [
                              tr("电磁", "EM"),
                              tr("热能", "Thermal"),
                              tr("动能", "Kinetic"),
                              tr("爆炸", "Explosive"),
                            ][index]
                          }
                          <input
                            className="fit-input"
                            type="number"
                            min={0}
                            max={1000000}
                            value={settingsProfile[damage]}
                            onChange={(event) => {
                              const value = Number(event.target.value);
                              if (
                                Number.isFinite(value) &&
                                value >= 0 &&
                                value <= 1000000
                              )
                                setSettingsProfile((current) => ({
                                  ...current,
                                  [damage]: value,
                                }));
                            }}
                          />
                        </label>
                      ),
                    )}
                  </div>
                  <button
                    className="fit-btn"
                    onClick={() =>
                      setSettingsProfile({
                        em: 25,
                        thermal: 25,
                        kinetic: 25,
                        explosive: 25,
                      })
                    }
                  >
                    {tr(
                      "均匀伤害 25 / 25 / 25 / 25",
                      "Omni damage 25 / 25 / 25 / 25",
                    )}
                  </button>
                </>
              )}
              {modal === "newShip" && (
                <p>
                  {tr(
                    `更换为 ${pendingShip?.name ?? ""} 将清空当前船上的装备、无人机和货舱。可通过“撤销”恢复当前装配。`,
                    `Changing to ${pendingShip?.name ?? ""} clears modules, drones and cargo. Undo restores the current fit.`,
                  )}
                </p>
              )}
            </div>
            <div className="fit-modal-footer">
              <button
                className="fit-btn"
                disabled={busy}
                onClick={() => setModal(null)}
              >
                {tr("关闭", "Close")}
              </button>
              {modal === "import" && (
                <button
                  className="fit-btn is-primary"
                  disabled={busy || !text.trim()}
                  onClick={() =>
                    void runAction(async () => {
                      const result = await fittingWorkbenchApi.import(
                        text,
                        language,
                      );
                      updateFit(result.fit);
                      setLoadedSaved(null);
                      setSelected(null);
                      setBrowserTab("hardware");
                      setModal(null);
                      setNotice(
                        result.warnings.length
                          ? result.warnings.join("；")
                          : tr("配置已导入。", "Fitting imported."),
                      );
                    })
                  }
                >
                  {busy ? (
                    <Loader2 className="fit-refresh-icon" size={13} />
                  ) : (
                    <Upload size={13} />
                  )}{" "}
                  {tr("导入并模拟", "Import & simulate")}
                </button>
              )}
              {modal === "export" && (
                <button
                  className="fit-btn is-primary"
                  disabled={busy || !text}
                  onClick={() =>
                    void runAction(async () => {
                      await navigator.clipboard.writeText(text);
                      setNotice(tr("装配文本已复制。", "Fitting text copied."));
                    })
                  }
                >
                  <Copy size={13} />
                  {tr("复制文本", "Copy text")}
                </button>
              )}
              {modal === "save" && (
                <>
                  {loadedSaved?.canEdit &&
                    loadedSaved.visibility === saveVisibility && (
                      <button
                        className="fit-btn"
                        disabled={busy || pending}
                        onClick={() => saveFit(true)}
                      >
                        {tr("更新原配置", "Update original")}
                      </button>
                    )}
                  <button
                    className="fit-btn is-primary"
                    disabled={busy || pending}
                    onClick={() => saveFit(false)}
                  >
                    {busy ? (
                      <Loader2 className="fit-refresh-icon" size={13} />
                    ) : (
                      <Save size={13} />
                    )}{" "}
                    {loadedSaved
                      ? tr("另存副本", "Save a copy")
                      : tr("保存", "Save")}
                  </button>
                </>
              )}
              {modal === "settings" && (
                <button
                  className="fit-btn is-primary"
                  onClick={() => {
                    if (
                      Object.values(settingsProfile).reduce(
                        (sum, value) => sum + value,
                        0,
                      ) <= 0
                    ) {
                      setModalError(
                        tr(
                          "至少一种伤害比例必须大于 0。",
                          "At least one damage type must be above zero.",
                        ),
                      );
                      return;
                    }
                    updateFit((current) => ({
                      ...current,
                      damageProfile: settingsProfile,
                    }));
                    setModal(null);
                  }}
                >
                  {tr("应用模型", "Apply profile")}
                </button>
              )}
              {modal === "newShip" && (
                <button
                  className="fit-btn is-primary"
                  onClick={() => {
                    if (pendingShip) activateShip(pendingShip);
                  }}
                >
                  {tr("更换舰船", "Change hull")}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
