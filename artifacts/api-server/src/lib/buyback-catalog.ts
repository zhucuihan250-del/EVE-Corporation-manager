import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type BuybackCatalogTarget = {
  id: number;
  name: string;
  nameEn?: string;
  categoryId?: number;
  categoryName?: string;
};
export type BuybackCatalogType = {
  typeId: number;
  name: string;
  categoryId: number;
  categoryName: string;
  marketGroupId: number | null;
};
type Catalog = {
  categories: Array<{ id: number; name: string; nameEn: string }>;
  types: Array<{
    id: number;
    name: string;
    nameEn: string;
    categoryId: number;
    marketGroupId: number | null;
    published: boolean;
  }>;
};
export function normalizeBuybackName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("en");
}

let cache: ReturnType<typeof buildIndex> | undefined;
function buildIndex(data: Catalog) {
  const searchable = <T extends { name: string; nameEn: string }>(item: T) => ({
    ...item,
    searchName: normalizeBuybackName(item.name),
    searchNameEn: normalizeBuybackName(item.nameEn),
  });
  const categories = new Map(
    data.categories.map((item) => [item.id, searchable(item)]),
  );
  const types = new Map(
    data.types.map((item) => [
      item.id,
      {
        ...searchable(item),
        categoryName:
          categories.get(item.categoryId)?.name ?? String(item.categoryId),
      },
    ]),
  );
  const names = new Map<string, number | null>();
  for (const item of types.values()) {
    for (const key of [item.searchName, item.searchNameEn]) {
      if (!key) continue;
      // Never pick an arbitrary item when localization has duplicate names.
      if (names.has(key) && names.get(key) !== item.id) names.set(key, null);
      else names.set(key, item.id);
    }
  }
  return { categories, types, names };
}
function targetView(item: BuybackCatalogTarget): BuybackCatalogTarget {
  return {
    id: item.id,
    name: item.name,
    nameEn: item.nameEn,
    ...(item.categoryId === undefined
      ? {}
      : { categoryId: item.categoryId, categoryName: item.categoryName }),
  };
}
function catalog() {
  if (cache) return cache;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = [
    path.resolve(here, "../data/eve-buyback-catalog.json"),
    path.resolve(here, "../src/data/eve-buyback-catalog.json"),
    path.resolve(process.cwd(), "src/data/eve-buyback-catalog.json"),
    path.resolve(
      process.cwd(),
      "artifacts/api-server/src/data/eve-buyback-catalog.json",
    ),
  ].find(existsSync);
  if (!file) throw new Error("物品目录暂时不可用，请联系管理员");
  cache = buildIndex(JSON.parse(readFileSync(file, "utf8")) as Catalog);
  return cache;
}

export async function resolveBuybackTypes(
  names: string[],
): Promise<Map<string, BuybackCatalogType>> {
  const index = catalog();
  const result = new Map<string, BuybackCatalogType>();
  for (const name of names) {
    const id = index.names.get(normalizeBuybackName(name));
    if (id === null || id === undefined) continue;
    const item = index.types.get(id)!;
    result.set(name, {
      typeId: item.id,
      name: item.name,
      categoryId: item.categoryId,
      categoryName: item.categoryName,
      marketGroupId: item.marketGroupId,
    });
  }
  return result;
}
export async function getBuybackTarget(
  scope: "category" | "type",
  id: number,
): Promise<BuybackCatalogTarget | null> {
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const index = catalog();
  const item =
    scope === "category" ? index.categories.get(id) : index.types.get(id);
  return item ? targetView(item) : null;
}
export async function searchBuybackCatalog(
  query: string,
  kind: "category" | "type",
): Promise<BuybackCatalogTarget[]> {
  const index = catalog();
  const key = normalizeBuybackName(query).slice(0, 100);
  const items =
    kind === "category"
      ? [...index.categories.values()]
      : [...index.types.values()];
  return items
    .filter(
      (item) =>
        item.id > 0 && (!key ||
        String(item.id) === key ||
        item.searchName.includes(key) ||
        item.searchNameEn.includes(key)),
    )
    .sort((a, b) => {
      const exact = (item: typeof a) =>
        Number(
          String(item.id) === key ||
            item.searchName === key ||
            item.searchNameEn === key,
        );
      return (
        exact(b) - exact(a) ||
        Number("published" in b && b.published) -
          Number("published" in a && a.published) ||
        a.id - b.id
      );
    })
    .slice(0, kind === "category" ? 100 : 50)
    .map(targetView);
}
