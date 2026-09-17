"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { HistoricalLocation } from "@historical-map/domain";
import { mapClient } from "@/lib/client";

export default function LocationsPage(): JSX.Element {
  const [locations, setLocations] = useState<HistoricalLocation[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    mapClient
      .getLocations()
      .then(({ locations }) => setLocations(locations))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      );
  }, []);

  const filtered = locations?.filter((l) =>
    l.name.toLowerCase().includes(filter.toLowerCase()),
  );

  return (
    <main className="container">
      <h1>Locations</h1>
      <p className="muted">
        Editing against {process.env["NEXT_PUBLIC_MAP_APP_URL"] ?? "http://localhost:3000"}.
        Changes go live on the map immediately (it polls every 5s).
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          Failed to load locations: {error}
        </div>
      )}

      {!error && !locations && <p>Loading…</p>}

      {locations && (
        <>
          <div className="field">
            <input
              placeholder="Filter by name…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Coordinates</th>
                <th>Events</th>
              </tr>
            </thead>
            <tbody>
              {filtered?.map((loc) => (
                <tr key={loc.id}>
                  <td>
                    <Link href={`/locations/${encodeURIComponent(loc.id)}`}>
                      {loc.name}
                    </Link>
                  </td>
                  <td className="muted">
                    {loc.coordinates[1].toFixed(4)}, {loc.coordinates[0].toFixed(4)}
                  </td>
                  <td>{loc.events.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered?.length === 0 && <p className="muted">No matches.</p>}
        </>
      )}
    </main>
  );
}
