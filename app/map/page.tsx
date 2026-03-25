"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import type { HistoricalLocation } from "./types";
import { getLocations, saveEventsData } from "./utils/storage";
import type { HistoricalEventsData } from "./types";
import { MapView } from "./components/MapView";

function MapContent(): JSX.Element {
  const [locations, setLocations] = useState<HistoricalLocation[]>([]);
  const lastUpdatedRef = useRef<string | null>(null);

  // Reload from localStorage on mount and when returning from import
  const searchParams = useSearchParams();
  const refreshKey = searchParams.get("t");

  useEffect(() => {
    const loaded = getLocations();
    console.log(
      "[Map] Loading locations, refreshKey:",
      refreshKey,
      "found:",
      loaded.length,
    );
    if (loaded.length > 0) {
      setLocations(loaded);
      return;
    }
    // First visit: seed localStorage from server data
    fetch("/api/data/locations")
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          json: { locations: HistoricalLocation[]; lastUpdated: string } | null,
        ) => {
          if (json?.locations?.length) {
            const seed: HistoricalEventsData = {
              version: "1.0.0",
              lastUpdated: json.lastUpdated,
              locations: json.locations,
            };
            saveEventsData(seed);
            setLocations(json.locations);
          }
        },
      )
      .catch(() => {});
  }, [refreshKey]);

  // Poll /api/data/locations every 5s to pick up changes from MCP server.
  // Pauses when tab is hidden. Falls back gracefully if API is unavailable.
  useEffect(() => {
    const apiKey = process.env["NEXT_PUBLIC_MAP_API_KEY"];
    if (!apiKey) return; // polling only when API key is configured

    let paused = false;
    const handleVisibility = () => {
      paused = document.hidden;
    };
    document.addEventListener("visibilitychange", handleVisibility);

    const id = setInterval(async () => {
      if (paused) return;
      try {
        const res = await fetch("/api/data/locations", {
          headers: apiKey ? { "x-api-key": apiKey } : {},
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          locations: HistoricalLocation[];
          lastUpdated: string;
        };
        if (json.lastUpdated && json.lastUpdated !== lastUpdatedRef.current) {
          lastUpdatedRef.current = json.lastUpdated;
          setLocations(json.locations);
        }
      } catch {
        // API unavailable — silently skip
      }
    }, 5000);

    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const handleRefresh = () => {
    setLocations(getLocations());
  };

  return <MapView locations={locations} onRefresh={handleRefresh} />;
}

export default function Page(): JSX.Element {
  return (
    <Suspense fallback={<div>Loading map...</div>}>
      <MapContent />
    </Suspense>
  );
}
