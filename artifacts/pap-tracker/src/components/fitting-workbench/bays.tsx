import { X } from "lucide-react";
import type {
  CanonicalFit,
  WorkbenchCatalogItem,
  WorkbenchSimulation,
} from "@/lib/fitting-workbench-types";
import { numberLabel, typeIcon } from "@/lib/fitting-workbench-presentation";
import { FIT_DRAG_TYPE, readFitDrag } from "./slot-ring";

type Bay = "drones" | "cargo" | "implants" | "boosters";
export function FittingBays({
  fit,
  simulation,
  lookup,
  bay,
  setBay,
  updateFit,
  tr,
  onDropItem,
}: {
  fit: CanonicalFit;
  simulation?: WorkbenchSimulation;
  lookup: Map<number, WorkbenchCatalogItem>;
  bay: Bay;
  setBay: (bay: Bay) => void;
  updateFit: (
    update: CanonicalFit | ((fit: CanonicalFit) => CanonicalFit),
  ) => void;
  tr: (cn: string, en: string) => string;
  onDropItem: (item: WorkbenchCatalogItem) => void;
}) {
  const remove = (typeId: number) =>
    updateFit((current) => ({
      ...current,
      [bay]: (current[bay] ?? []).filter((entry) => entry.typeId !== typeId),
    }));
  return (
    <div
      className="fit-bays"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(FIT_DRAG_TYPE))
          event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const data = readFitDrag(event);
        if (data?.kind === "catalog") onDropItem(data.item);
      }}
    >
      <div className="fit-bay-tabs">
        {(["drones", "cargo", "implants", "boosters"] as const).map(
          (nextBay, index) => (
            <button
              className={bay === nextBay ? "is-active" : ""}
              key={nextBay}
              onClick={() => setBay(nextBay)}
            >
              {
                [
                  tr("无人机舱", "Drone bay"),
                  tr("货舱", "Cargo bay"),
                  tr("植入体", "Implants"),
                  tr("增效剂", "Boosters"),
                ][index]
              }
              <small>
                {nextBay === "drones"
                  ? fit.drones.reduce((sum, entry) => sum + entry.quantity, 0)
                  : nextBay === "cargo"
                    ? fit.cargo.length
                    : (fit[nextBay]?.length ?? 0)}
              </small>
            </button>
          ),
        )}
      </div>
      <div className="fit-bay-content">
        {bay === "drones" && (
          <>
            <div className="fit-bay-summary">
              <span
                className={
                  simulation &&
                  simulation.stats.drones.bayUsed >
                    simulation.stats.drones.bayCapacity
                    ? "is-overloaded"
                    : ""
                }
              >
                {tr("容量", "Bay")}{" "}
                {numberLabel(simulation?.stats.drones.bayUsed)} /{" "}
                {numberLabel(simulation?.stats.drones.bayCapacity)} m³
              </span>
              <span
                className={
                  simulation &&
                  simulation.stats.drones.bandwidthUsed >
                    simulation.stats.drones.bandwidthCapacity
                    ? "is-overloaded"
                    : ""
                }
              >
                {tr("带宽", "Bandwidth")}{" "}
                {numberLabel(simulation?.stats.drones.bandwidthUsed)} /{" "}
                {numberLabel(simulation?.stats.drones.bandwidthCapacity)} Mbit/s
              </span>
              <span>
                {tr("出战", "Active")} {simulation?.stats.drones.active ?? 0} /{" "}
                {simulation?.stats.drones.activeLimit ?? 0}
              </span>
            </div>
            {fit.drones.map((entry) => (
              <div className="fit-bay-row" key={entry.typeId}>
                <img src={typeIcon(entry.typeId)} alt="" />
                <span>
                  {lookup.get(entry.typeId)?.name ?? `#${entry.typeId}`}
                </span>
                <label>
                  {tr("携带", "Bay")}
                  <input
                    className="fit-input"
                    type="number"
                    min={1}
                    max={1000}
                    value={entry.quantity}
                    aria-label={`${lookup.get(entry.typeId)?.name ?? entry.typeId} ${tr("携带数量", "bay quantity")}`}
                    onChange={(event) => {
                      const quantity = Number(event.target.value);
                      if (
                        !Number.isSafeInteger(quantity) ||
                        quantity <= 0 ||
                        quantity > 1000
                      )
                        return;
                      updateFit((current) => ({
                        ...current,
                        drones: current.drones.map((item) =>
                          item.typeId === entry.typeId
                            ? {
                                ...item,
                                quantity,
                                activeQuantity: Math.min(
                                  quantity,
                                  item.activeQuantity,
                                ),
                              }
                            : item,
                        ),
                      }));
                    }}
                  />
                </label>
                <label>
                  {tr("出战", "Active")}
                  <input
                    className="fit-input"
                    type="number"
                    min={0}
                    max={entry.quantity}
                    value={entry.activeQuantity}
                    aria-label={`${lookup.get(entry.typeId)?.name ?? entry.typeId} ${tr("出战数量", "active quantity")}`}
                    onChange={(event) => {
                      const activeQuantity = Number(event.target.value);
                      if (
                        !Number.isSafeInteger(activeQuantity) ||
                        activeQuantity < 0 ||
                        activeQuantity > entry.quantity
                      )
                        return;
                      updateFit((current) => ({
                        ...current,
                        drones: current.drones.map((item) =>
                          item.typeId === entry.typeId
                            ? { ...item, activeQuantity }
                            : item,
                        ),
                      }));
                    }}
                  />
                </label>
                <button
                  className="fit-btn is-icon"
                  aria-label={`${tr("移除", "Remove")} ${lookup.get(entry.typeId)?.name ?? entry.typeId}`}
                  onClick={() => remove(entry.typeId)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {!fit.drones.length && (
              <p className="fit-bay-hint">
                {tr(
                  "从装备浏览器添加无人机。设置“出战”数量后才计入伤害。",
                  "Add drones from the browser. Only active drones contribute damage.",
                )}
              </p>
            )}
          </>
        )}
        {bay === "cargo" && (
          <>
            <div className="fit-bay-summary">
              <span
                className={
                  simulation &&
                  simulation.stats.cargo.used > simulation.stats.cargo.capacity
                    ? "is-overloaded"
                    : ""
                }
              >
                {tr("货舱容量", "Cargo capacity")}{" "}
                {numberLabel(simulation?.stats.cargo.used)} /{" "}
                {numberLabel(simulation?.stats.cargo.capacity)} m³
              </span>
            </div>
            {fit.cargo.map((entry) => (
              <div className="fit-bay-row" key={entry.typeId}>
                <img src={typeIcon(entry.typeId)} alt="" />
                <span>
                  {lookup.get(entry.typeId)?.name ?? `#${entry.typeId}`}
                </span>
                <label>
                  {tr("数量", "Qty")}
                  <input
                    className="fit-input"
                    type="number"
                    min={1}
                    max={1000000}
                    value={entry.quantity}
                    aria-label={`${lookup.get(entry.typeId)?.name ?? entry.typeId} ${tr("货物数量", "cargo quantity")}`}
                    onChange={(event) => {
                      const quantity = Number(event.target.value);
                      if (
                        !Number.isSafeInteger(quantity) ||
                        quantity < 1 ||
                        quantity > 1000000
                      )
                        return;
                      updateFit((current) => ({
                        ...current,
                        cargo: current.cargo.map((item) =>
                          item.typeId === entry.typeId
                            ? { ...item, quantity }
                            : item,
                        ),
                      }));
                    }}
                  />
                </label>
                <button
                  className="fit-btn is-icon"
                  aria-label={`${tr("移除", "Remove")} ${lookup.get(entry.typeId)?.name ?? entry.typeId}`}
                  onClick={() => remove(entry.typeId)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {!fit.cargo.length && (
              <p className="fit-bay-hint">
                {tr(
                  "将弹药等物品拖入货舱，携带物品不会作为已安装装备计算。",
                  "Drag charges and supplies into cargo. Cargo items are not fitted modules.",
                )}
              </p>
            )}
          </>
        )}
        {(bay === "implants" || bay === "boosters") && (
          <>
            {fit[bay]?.map((entry) => (
              <div className="fit-bay-row" key={entry.typeId}>
                <img src={typeIcon(entry.typeId)} alt="" />
                <span>
                  {lookup.get(entry.typeId)?.name ?? `#${entry.typeId}`}
                </span>
                <button
                  className="fit-btn is-icon"
                  aria-label={`${tr("移除", "Remove")} ${lookup.get(entry.typeId)?.name ?? entry.typeId}`}
                  onClick={() => remove(entry.typeId)}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {!fit[bay]?.length && (
              <p className="fit-bay-hint">
                {tr(
                  "从装备浏览器添加。植入体和增效剂将应用到模拟角色。",
                  "Add implants or boosters from the browser to apply them to the simulated pilot.",
                )}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
