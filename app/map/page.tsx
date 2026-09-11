"use client";

import { useEffect, useState, useRef, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import type { EventLayer, EventSource, HistoricalLocation } from "./types";
import { getLocations, saveEventsData } from "./utils/storage";
import type { HistoricalEventsData } from "./types";
import { MapView } from "./components/MapView";
import { eventLayersFromSources, getEventLayers } from "./utils/event-layers";

/**
 * `x-api-key` for /api/data/* when one is configured. The routes treat a
 * missing MAP_API_KEY as "allow", so an empty header set is correct locally.
 */
function apiKeyHeaders(): Record<string, string> {
  const apiKey = process.env["NEXT_PUBLIC_MAP_API_KEY"];
  return apiKey ? { "x-api-key": apiKey } : {};
}

function MapContent(): JSX.Element {
  const [locations, setLocations] = useState<HistoricalLocation[]>([]);
  const lastUpdatedRef = useRef<string | null>(null);

  // Event layers come from the server's source list, so a source the ingestion
  // pipeline published gets a layer without a code change.
  //
  // `null` means "not resolved yet" and deliberately blocks the first render:
  // MapView seeds its layer state with a lazy `useState` initializer, so a
  // layer list that arrives after mount is silently ignored. Rendering early
  // with a default would therefore pin the map to the hardcoded demo layer for
  // the rest of the session.
  const [eventLayers, setEventLayers] = useState<EventLayer[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/sources", { headers: apiKeyHeaders() })
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { sources?: EventSource[] } | null) => {
        if (cancelled) return;
        setEventLayers(
          json?.sources?.length
            ? eventLayersFromSources(json.sources)
            : getEventLayers(),
        );
      })
      .catch(() => {
        // Fall back to the static registry rather than rendering no layers at
        // all — the deployed demo has no database to list sources from.
        if (!cancelled) setEventLayers(getEventLayers());
      });
    return () => {
      cancelled = true;
    };
  }, []);

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
    // First visit: seed localStorage from server data.
    // The key must be sent here too — /api/data/locations is gated on
    // MAP_API_KEY, so an unauthenticated seed 401s wherever it is configured.
    fetch("/api/data/locations", { headers: apiKeyHeaders() })
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
          headers: apiKeyHeaders(),
        });
        if (!res.ok) return;
        const json = (await res.json()) as {
          locations: HistoricalLocation[];
          lastUpdated: string;
        };
        if (json.lastUpdated && json.lastUpdated !== lastUpdatedRef.current) {
          lastUpdatedRef.current = json.lastUpdated;
          setLocations(json.locations);
          // Persist, or the update is in-memory only and a reload drops back
          // to the stale localStorage copy — which is what made server-side
          // writes look like they had silently failed.
          saveEventsData({
            version: "1.0.0",
            lastUpdated: json.lastUpdated,
            locations: json.locations,
          });
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

  if (!eventLayers) return <div>Loading map...</div>;

  return (
    <MapView
      locations={locations}
      initialEventLayers={eventLayers}
      onRefresh={handleRefresh}
    />
  );
}

export default function Page(): JSX.Element {
  return (
    <Suspense fallback={<div>Loading map...</div>}>
      <MapContent />
    </Suspense>
  );
}
