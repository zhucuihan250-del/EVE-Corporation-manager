import type { DragEvent, ReactNode } from "react";
import { Ship, Zap } from "lucide-react";
import type {
  CanonicalFit,
  WorkbenchCatalogItem,
  WorkbenchRack,
  WorkbenchSimulation,
} from "@/lib/fitting-workbench-types";
import {
  numberLabel,
  rackOrder,
  rackNames,
  slotKey,
  stateNames,
  stateSymbols,
  typeIcon,
} from "@/lib/fitting-workbench-presentation";

export const FIT_DRAG_TYPE = "application/x-eve-fitting";
export type FitDrag =
  | { kind: "catalog"; item: WorkbenchCatalogItem }
  | { kind: "slot"; rack: WorkbenchRack; index: number };
export function readFitDrag(event: DragEvent): FitDrag | null {
  try {
    const raw = event.dataTransfer.getData(FIT_DRAG_TYPE);
    if (raw.length > 20_000) return null;
    const data = JSON.parse(raw);
    return (data.kind === "catalog" &&
      Number.isSafeInteger(data.item?.typeId) &&
      data.item.typeId > 0 &&
      typeof data.item.name === "string" &&
      data.item.name.length <= 1000 &&
      [
        "ship",
        "module",
        "charge",
        "drone",
        "subsystem",
        "fighter",
        "implant",
        "booster",
        "cargo",
        "skill",
      ].includes(data.item.category) &&
      [
        ...rackOrder,
        "charge",
        "drone",
        "fighter",
        "implant",
        "booster",
        "other",
      ].includes(data.item.slot) &&
      (data.item.capabilities?.maxState === undefined ||
        ["online", "active", "overheated"].includes(
          data.item.capabilities.maxState,
        ))) ||
      (data.kind === "slot" &&
        rackOrder.includes(data.rack) &&
        Number.isSafeInteger(data.index) &&
        data.index >= 0 &&
        data.index < 32)
      ? (data as FitDrag)
      : null;
  } catch {
    return null;
  }
}
function polar(angle: number, radius: number) {
  const radians = (angle * Math.PI) / 180;
  return {
    x: 280 + Math.cos(radians) * radius,
    y: 280 + Math.sin(radians) * radius,
  };
}
function arc(start: number, end: number, radius: number) {
  const a = polar(start, radius),
    b = polar(end, radius);
  return `M ${a.x} ${a.y} A ${radius} ${radius} 0 ${end - start > 180 ? 1 : 0} 1 ${b.x} ${b.y}`;
}
export function SlotRing({
  fit,
  simulation,
  lookup,
  selected,
  onSelect,
  onCycle,
  onDrop,
  onUnfit,
  zh,
  preview,
}: {
  fit: CanonicalFit;
  simulation?: WorkbenchSimulation;
  lookup: Map<number, WorkbenchCatalogItem>;
  selected: { rack: WorkbenchRack; index: number } | null;
  onSelect: (rack: WorkbenchRack, index: number) => void;
  onCycle: (rack: WorkbenchRack, index: number, reverse: boolean) => void;
  onDrop: (
    data: FitDrag,
    rack?: WorkbenchRack,
    index?: number,
    duplicate?: boolean,
  ) => void;
  onUnfit: (rack: WorkbenchRack, index: number) => void;
  zh: boolean;
  preview?: ReactNode;
}) {
  const tr = (cn: string, en: string) => (zh ? cn : en);
  const racks: Array<{
    rack: WorkbenchRack;
    start: number;
    end: number;
    label: number;
  }> = [
    { rack: "high", start: -171, end: -92, label: -128 },
    { rack: "medium", start: -76, end: -4, label: -43 },
    { rack: "low", start: 10, end: 82, label: 48 },
    { rack: "rig", start: 111, end: 157, label: 139 },
  ];
  const renderSlot = (
    rack: WorkbenchRack,
    index: number,
    style?: React.CSSProperties,
  ) => {
    const entry = fit.slots.find(
      (slot) => slot.rack === rack && slot.index === index,
    );
    const item = entry ? lookup.get(entry.typeId) : undefined;
    const effective = simulation?.moduleStates.find(
      (state) =>
        state.rack === rack &&
        state.index === index &&
        state.typeId === entry?.typeId,
    );
    const state = effective?.state ?? entry?.state;
    const label = `${rackNames[rack][zh ? 0 : 1]} ${index + 1}${entry ? ` · ${item?.name ?? `#${entry.typeId}`} · ${stateNames[state!][zh ? 0 : 1]}` : ` · ${tr("空槽", "Empty")}`}`;
    return (
      <button
        key={slotKey(rack, index)}
        type="button"
        className={`fit-slot ${entry ? `state-${state}` : "is-empty"} ${selected?.rack === rack && selected.index === index ? "is-selected" : ""}`}
        style={style}
        title={`${label}${entry ? `\n${tr("点击切换状态；Shift 反向；右键查看装填与卸载。", "Click to cycle state; Shift reverses; right-click for charges and unfit.")}` : ""}`}
        aria-label={label}
        draggable={!!entry}
        onDragStart={(event) => {
          event.dataTransfer.setData(
            FIT_DRAG_TYPE,
            JSON.stringify({ kind: "slot", rack, index }),
          );
          event.dataTransfer.effectAllowed = "copyMove";
        }}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(FIT_DRAG_TYPE)) {
            event.preventDefault();
            event.dataTransfer.dropEffect = event.shiftKey ? "copy" : "move";
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const data = readFitDrag(event);
          if (data) onDrop(data, rack, index, event.shiftKey);
        }}
        onClick={(event) => {
          onSelect(rack, index);
          if (entry) onCycle(rack, index, event.shiftKey);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          onSelect(rack, index);
        }}
        onKeyDown={(event) => {
          if (entry && (event.key === "Delete" || event.key === "Backspace")) {
            event.preventDefault();
            onUnfit(rack, index);
          }
        }}
      >
        {entry ? (
          <>
            <img src={typeIcon(entry.typeId)} alt="" />
            <span className="fit-slot-state" aria-hidden="true">
              {stateSymbols[state!]}
            </span>
            {entry.chargeTypeId && (
              <span
                className="fit-slot-charge"
                title={
                  lookup.get(entry.chargeTypeId)?.name ??
                  `#${entry.chargeTypeId}`
                }
              >
                <img src={typeIcon(entry.chargeTypeId)} alt="" />
              </span>
            )}
          </>
        ) : (
          <>
            <span className="fit-slot-empty-mark">
              {rack === "high"
                ? "Ⅲ"
                : rack === "medium"
                  ? "Ⅱ"
                  : rack === "low"
                    ? "Ⅰ"
                    : "◇"}
            </span>
            <small>{index + 1}</small>
          </>
        )}
      </button>
    );
  };
  const overflowSlots = simulation
    ? fit.slots.filter(
        (entry) => entry.index >= simulation.slots[entry.rack].limit,
      )
    : [];
  return (
    <div className="fit-ship-workspace">
      <div
        className="fit-ring"
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(FIT_DRAG_TYPE))
            event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          const data = readFitDrag(event);
          if (data) onDrop(data);
        }}
      >
        <svg
          viewBox="0 0 560 560"
          className="fit-ring-decoration"
          aria-hidden="true"
        >
          <defs>
            <radialGradient id="fit-holo-glow">
              <stop stopColor="#25465b" stopOpacity=".5" />
              <stop offset="1" stopColor="#06101c" stopOpacity=".8" />
            </radialGradient>
          </defs>
          <circle cx="280" cy="280" r="207" fill="url(#fit-holo-glow)" />
          <circle
            cx="280"
            cy="280"
            r="255"
            fill="none"
            stroke="#4b6674"
            strokeOpacity=".45"
            strokeWidth="1"
          />
          <circle
            cx="280"
            cy="280"
            r="215"
            fill="none"
            stroke="#4b6674"
            strokeOpacity=".22"
            strokeWidth="1"
          />
          {racks.map(({ rack, start, end }) => (
            <path
              key={rack}
              d={arc(start - 5, end + 5, 232)}
              fill="none"
              stroke="#a4b9c4"
              strokeOpacity=".07"
              strokeWidth="47"
            />
          ))}
          <path
            d={arc(162, 182, 253)}
            fill="none"
            stroke="#344853"
            strokeWidth="7"
          />
          <path
            d={arc(
              163,
              163 +
                Math.min(
                  1,
                  (simulation?.resources.calibration.percent ?? 0) / 100,
                ) *
                  18,
              253,
            )}
            fill="none"
            stroke={
              simulation?.resources.calibration.overloaded
                ? "#ef6664"
                : "#94a4b4"
            }
            strokeWidth="7"
          />
        </svg>
        <div className="fit-ship-preview">
          {preview ??
            (fit.shipTypeId ? (
              <img
                src={`https://images.evetech.net/types/${fit.shipTypeId}/render?size=512`}
                alt={simulation?.ship.name ?? tr("舰船预览", "Ship preview")}
                className="fit-ship-render"
              />
            ) : (
              <Ship size={72} />
            ))}
        </div>
        <div className="fit-ship-identity">
          <span>{tr("模拟模式", "SIMULATION")}</span>
          <strong>
            {simulation?.ship.name ??
              lookup.get(fit.shipTypeId)?.name ??
              tr("请选择舰船", "Select a hull")}
          </strong>
          <small>{simulation?.ship.groupName ?? ""}</small>
        </div>
        {racks.map(({ rack, start, end, label }) => {
          const metric =
            simulation?.slots[rack as keyof WorkbenchSimulation["slots"]];
          const limit = Math.min(12, Math.max(0, metric?.limit ?? 0));
          const point = polar(label, 275);
          return (
            <div key={rack} className="fit-rack">
              <span
                className={`fit-rack-label ${metric?.overloaded ? "is-overloaded" : ""}`}
                style={{
                  left: `${(point.x / 560) * 100}%`,
                  top: `${(point.y / 560) * 100}%`,
                }}
              >
                {rackNames[rack][zh ? 0 : 1]}{" "}
                <b>{metric ? `${metric.used}/${metric.limit}` : "—"}</b>
              </span>
              {Array.from({ length: limit }, (_, index) => {
                const point = polar(
                  limit === 1
                    ? (start + end) / 2
                    : start + (index * (end - start)) / (limit - 1),
                  233,
                );
                return renderSlot(rack, index, {
                  left: `${(point.x / 560) * 100}%`,
                  top: `${(point.y / 560) * 100}%`,
                });
              })}
            </div>
          );
        })}
        <div className="fit-hardpoints">
          {(["turret", "launcher"] as const).map((key) => (
            <div
              key={key}
              title={tr(
                key === "turret" ? "炮塔挂点" : "导弹挂点",
                key === "turret" ? "Turret hardpoints" : "Launcher hardpoints",
              )}
            >
              <span>{key === "turret" ? "⊕" : "⌁"}</span>
              {Array.from(
                {
                  length: Math.min(12, simulation?.hardpoints[key].limit ?? 0),
                },
                (_, index) => (
                  <i
                    key={index}
                    className={
                      index < (simulation?.hardpoints[key].used ?? 0)
                        ? "is-used"
                        : ""
                    }
                  />
                ),
              )}
              <small>
                {simulation?.hardpoints[key].used ?? 0}/
                {simulation?.hardpoints[key].limit ?? 0}
              </small>
            </div>
          ))}
          <div
            className={
              simulation?.resources.calibration.overloaded
                ? "is-overloaded"
                : ""
            }
          >
            <span>{tr("校准", "Calibration")}</span>
            <small>
              {numberLabel(simulation?.resources.calibration.used, 0)} /{" "}
              {numberLabel(simulation?.resources.calibration.limit, 0)}
            </small>
          </div>
        </div>
        <div className="fit-ring-resources">
          {(["cpu", "powergrid"] as const).map((key) => {
            const metric = simulation?.resources[key];
            return (
              <div
                key={key}
                className={metric?.overloaded ? "is-overloaded" : ""}
              >
                <span>
                  {key === "cpu" ? "CPU" : tr("能量栅格", "Powergrid")}
                </span>
                <strong>
                  {numberLabel(metric?.used)}
                  <small>
                    {" "}
                    / {numberLabel(metric?.limit)} {key === "cpu" ? "tf" : "MW"}
                  </small>
                </strong>
                <div>
                  <i
                    style={{ width: `${Math.min(100, metric?.percent ?? 0)}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {(["subsystem", "service"] as const).map((rack) => {
        const limit = simulation?.slots[rack].limit ?? 0;
        return limit > 0 ? (
          <div className="fit-extra-rack" key={rack}>
            <span>{rackNames[rack][zh ? 0 : 1]}</span>
            <div>
              {Array.from({ length: Math.min(limit, 8) }, (_, index) =>
                renderSlot(rack, index),
              )}
            </div>
          </div>
        ) : null;
      })}
      {overflowSlots.length > 0 && (
        <div className="fit-overflow-slots">
          <strong>
            {tr("超出船体槽位的装备", "Modules outside hull slots")}
          </strong>
          {overflowSlots.map((entry) => (
            <div key={`${entry.rack}:${entry.index}`}>
              <button
                className="fit-btn is-small"
                onClick={() => onSelect(entry.rack, entry.index)}
              >
                {rackNames[entry.rack][zh ? 0 : 1]} {entry.index + 1} ·{" "}
                {lookup.get(entry.typeId)?.name ?? `#${entry.typeId}`}
              </button>
              <button
                className="fit-btn is-small is-danger"
                onClick={() => onUnfit(entry.rack, entry.index)}
              >
                {tr("卸载", "Unfit")}
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="fit-state-legend">
        {Object.entries(stateNames).map(([state, name]) => (
          <span className={`state-${state}`} key={state}>
            <b>{stateSymbols[state as keyof typeof stateSymbols]}</b>
            {name[zh ? 0 : 1]}
          </span>
        ))}
        <span>
          <Zap size={11} />
          {tr("点击装备切换状态", "Click modules to cycle state")}
        </span>
      </div>
    </div>
  );
}
