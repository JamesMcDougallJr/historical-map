"use client";

import { useEffect, useState } from "react";
import type { GeocodeReviewItem } from "@historical-map/domain";

type Busy = Record<string, boolean>;

function pct(p: number | null): string {
  return p === null ? "—" : `${Math.round(p * 100)}%`;
}

function where(p: { lat: number; lon: number; displayName: string } | null): string {
  return p ? `${p.displayName} (${p.lat.toFixed(3)}, ${p.lon.toFixed(3)})` : "—";
}

export default function GeocodesPage(): JSX.Element {
  const [items, setItems] = useState<GeocodeReviewItem[] | null>(null);
  const [threshold, setThreshold] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});

  const reload = (): void => {
    fetch("/api/geocodes")
      .then(async (res) => {
        const body = (await res.json()) as {
          data?: GeocodeReviewItem[];
          threshold?: number;
          message?: string;
          error?: string;
        };
        if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
        setItems(body.data ?? []);
        setThreshold(body.threshold ?? null);
        setDraft(String(body.threshold ?? ""));
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(reload, []);

  const send = async (key: string, url: string, init: RequestInit): Promise<void> => {
    setBusy((b) => ({ ...b, [key]: true }));
    try {
      const res = await fetch(url, init);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, [key]: false }));
    }
  };

  const review = (id: string, action: "confirm" | "reject"): Promise<void> =>
    send(id, `/api/geocodes/${encodeURIComponent(id)}/${action}`, { method: "POST" });

  const saveThreshold = (): Promise<void> =>
    send("threshold", "/api/geocodes/threshold", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ minConfidence: Number(draft) }),
    });

  const unreviewed = items?.filter((i) => i.status === "auto") ?? [];
  const reviewed = items?.filter((i) => i.status !== "auto") ?? [];

  const card = (item: GeocodeReviewItem): JSX.Element => (
    <div className="card" key={item.id} data-testid={`geocode-${item.id}`}>
      <div className="row">
        <div className="field">
          <label>Place name</label>
          <strong>{item.placeName}</strong>
          <div className="muted">
            {item.status === "auto" ? "not reviewed" : item.status} · {item.provider ?? "?"} ·{" "}
            {item.publishedEvents} event(s) on the map
          </div>
          {item.context && (
            <>
              <p>
                <em>{item.context.title}</em>
              </p>
              {item.context.description && <div className="muted">{item.context.description}</div>}
            </>
          )}
        </div>
        <div className="field">
          <label>Pinned at</label>
          <div>{item.status === "rejected" ? "Rejected — no pin" : where(item.pinned)}</div>
          <label>Gazetteer tiers said</label>
          <div className="muted">{where(item.tierAnswer)}</div>
        </div>
      </div>
      <p className="muted" data-testid="geocode-confidence">
        Jev confidence {pct(item.confidence)}
        {item.threshold !== null && ` · held to ${pct(item.threshold)}`}
      </p>
      {item.status === "auto" && (
        <div className="row" style={{ gap: "0.5rem" }}>
          <button
            className="primary"
            disabled={busy[item.id] || !item.pinned}
            onClick={() => void review(item.id, "confirm")}
          >
            Right — keep it
          </button>
          <button
            className="danger"
            disabled={busy[item.id]}
            onClick={() => void review(item.id, "reject")}
          >
            Wrong — reject{item.publishedEvents ? ` (${item.publishedEvents} to review)` : ""}
          </button>
        </div>
      )}
    </div>
  );

  return (
    <main className="container">
      <h1>Geocodes</h1>
      <p className="muted">
        Places a model pinned using the event&apos;s context. Rejecting one takes its events
        off the map and back to review, and the place is never re-pinned automatically —
        use <code>geocode:review --set</code> to give the right coordinates.
      </p>

      <div className="card">
        <label htmlFor="threshold">Minimum Jev confidence to override the gazetteers</label>
        <div className="row" style={{ gap: "0.5rem", alignItems: "center" }}>
          <input
            id="threshold"
            type="number"
            min={0}
            max={1}
            step={0.05}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            disabled={busy["threshold"] || draft === String(threshold)}
            onClick={() => void saveThreshold()}
          >
            Save
          </button>
          <span className="muted">applies to the next decision</span>
        </div>
      </div>

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          {error}
        </div>
      )}
      {!error && !items && <p>Loading…</p>}

      {items && (
        <>
          <h2>Not reviewed ({unreviewed.length})</h2>
          {unreviewed.length === 0 && <p className="muted">Nothing waiting.</p>}
          {unreviewed.map(card)}

          <h2>Reviewed ({reviewed.length})</h2>
          {reviewed.length === 0 && <p className="muted">None.</p>}
          {reviewed.map(card)}
        </>
      )}
    </main>
  );
}
