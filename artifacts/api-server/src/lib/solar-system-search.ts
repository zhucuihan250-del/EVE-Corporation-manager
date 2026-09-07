import { solarSystemCatalog } from "../data/solar-systems";

export type SolarSystemSearchResult = {
  solarSystemId: number;
  solarSystemName: string;
};

const searchableSystems = solarSystemCatalog.map((system) => ({
  ...system,
  normalizedName: system.name.toUpperCase(),
}));

const nameCollator = new Intl.Collator("en", {
  numeric: true,
  sensitivity: "base",
});

export function searchSolarSystems(
  query: string,
  limit = 12,
): SolarSystemSearchResult[] {
  const normalizedQuery = query.trim().toUpperCase();
  if (normalizedQuery.length < 2) return [];
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 25);

  return searchableSystems
    .flatMap((system) => {
      const matchIndex = system.normalizedName.indexOf(normalizedQuery);
      if (matchIndex < 0) return [];
      return [{
        system,
        rank: system.normalizedName === normalizedQuery
          ? 0
          : matchIndex === 0 ? 1 : 2,
      }];
    })
    .sort((left, right) =>
      left.rank - right.rank
      || left.system.name.length - right.system.name.length
      || nameCollator.compare(left.system.name, right.system.name),
    )
    .slice(0, safeLimit)
    .map(({ system }) => ({
      solarSystemId: system.id,
      solarSystemName: system.name,
    }));
}
