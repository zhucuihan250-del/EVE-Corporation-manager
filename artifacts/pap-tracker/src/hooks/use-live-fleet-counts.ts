import { useState, useEffect, useRef, useCallback } from "react";
import { apiUrl } from "@/lib/api";

type Fleet = { id: number; isActive: boolean; eveFleetId?: string | null };

export function useLiveFleetCounts(fleets: Fleet[] | undefined) {
  const [liveCounts, setLiveCounts] = useState<Record<number, number>>({});
  const fleetsRef = useRef(fleets);
  fleetsRef.current = fleets;

  const scanFleet = useCallback(async (fleetId: number) => {
    const resp = await fetch(apiUrl(`/api/fleets/${fleetId}/scan?dryRun=true`), {
      method: "POST",
      credentials: "include",
    });
    if (!resp.ok) throw new Error("ESI scan failed");
    const data = await resp.json() as { esiMemberCount?: number };
    if (data.esiMemberCount !== undefined) {
      setLiveCounts(prev => ({ ...prev, [fleetId]: data.esiMemberCount! }));
    }
    return data.esiMemberCount ?? 0;
  }, []);

  useEffect(() => {
    const autoScan = async () => {
      const fleetList = Array.isArray(fleetsRef.current) ? fleetsRef.current : [];
      const activeFleets = fleetList.filter(f => f.isActive && f.eveFleetId);
      for (const fleet of activeFleets) {
        try {
          await scanFleet(fleet.id);
        } catch {
        }
      }
    };

    autoScan();
    const interval = setInterval(autoScan, 60 * 1000);
    return () => clearInterval(interval);
  }, [scanFleet]);

  return { liveCounts, scanFleet };
}
