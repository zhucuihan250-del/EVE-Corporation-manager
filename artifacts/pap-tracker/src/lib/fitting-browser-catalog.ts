import type {
  WorkbenchCategory,
  WorkbenchRack,
} from "./fitting-workbench-types";

export type FittingBrowserTab = "ships" | "hardware" | "saved";

export interface FittingCatalogOptions {
  q?: string;
  typeIds?: string;
  category?: string;
  slot?: string;
  language: string;
  limit?: number;
  shipTypeId?: number;
  chargeForTypeId?: number;
  subsystemTypeIds?: string;
}

/** Keep the request and its cache identity aligned with the current fitting. */
export function fittingBrowserCatalogQuery(context: {
  tab: FittingBrowserTab;
  query: string;
  category: WorkbenchCategory;
  rack: WorkbenchRack | "all";
  language: string;
  shipTypeId: number;
  selectedTypeId?: number;
  subsystemTypeIds?: number[];
}) {
  const hardware = context.tab === "hardware";
  const hasHull =
    Number.isSafeInteger(context.shipTypeId) && context.shipTypeId > 0;
  const options: FittingCatalogOptions = {
    q: context.query,
    language: context.language,
    category: context.tab === "ships" ? "ship" : context.category,
    slot:
      hardware && context.category === "module"
        ? context.rack
        : hardware && context.category === "subsystem"
          ? "subsystem"
          : "all",
    limit: 100,
  };
  if (hardware && hasHull) {
    options.shipTypeId = context.shipTypeId;
    options.subsystemTypeIds = [...(context.subsystemTypeIds ?? [])]
      .sort((a, b) => a - b)
      .join(",");
    if (
      context.category === "charge" &&
      Number.isSafeInteger(context.selectedTypeId) &&
      (context.selectedTypeId ?? 0) > 0
    )
      options.chargeForTypeId = context.selectedTypeId;
  }
  return {
    options,
    enabled: context.tab === "ships" || (hardware && hasHull),
    queryKey: ["fittingWorkbench", "catalog", options] as const,
  };
}
