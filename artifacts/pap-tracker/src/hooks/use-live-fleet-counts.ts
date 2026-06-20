import { useState, useEffect, useRef } from "react";

type Fleet = { id: number; isActive: boolean; eveFleetId?: string | null };

export function useLiveFleetCounts(fleets: Fleet[] | undefined) {
  const [liveCounts, setLiveCounts] = useState<Record<number, number>>({});
  const fleetsRef = useRef(fleets);
  fleetsRef.current = fleets;

  useEffect(() => {
    const autoScan = async () => {
      const activeFleets = (fleetsRef.current ?? []).filter(f => f.isActive && f.eveFleetId);
      for (const fleet of activeFleets) {
        try {
          const resp = await fetch(`/api/fleets/${fleet.id}/scan?dryRun=true`, {
            method: "POST",
            credentials: "include",
          });
          if (!resp.ok) continue;
          const data = await resp.json() as { esiMemberCount?: number };
          if (data.esiMemberCount !== undefined) {
            setLiveCounts(prev => ({ ...prev, [fleet.id]: data.esiMemberCount! }));
          }
        } catch {
        }
      }
    };

    autoScan();
    const interval = setInterval(autoScan, 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  return liveCounts;
}
