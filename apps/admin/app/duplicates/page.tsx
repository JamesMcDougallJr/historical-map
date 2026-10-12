"use client";

import { useEffect, useState } from "react";
import type { DuplicateItem } from "@historical-map/domain";

type Busy = Record<string, boolean>;

function pct(p: number | null): string {
  return p === null ? "—" : `${Math.round(p * 100)}%`;
}

export default function DuplicatesPage(): JSX.Element {
  const [items, setItems] = useState<DuplicateItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});

  const reload = (): void => {
    fetch("/api/duplicates")
      .then(async (res) => {
        const body = (await res.json()) as { data?: DuplicateItem[]; message?: string; error?: string };
        if (!res.ok) throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
        setItems(body.data ?? []);
        setError(null);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  useEffect(reload, []);

  const resolve = async (eventKey: string, action: "approve" | "dismiss"): Promise<void> => {
    setBusy((b) => ({ ...b, [eventKey]: true }));
    try {
      const res = await fetch(
        `/api/duplicates/${encodeURIComponent(eventKey)}/${action}`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy((b) => ({ ...b, [eventKey]: false }));
    }
  };

  const held = items?.filter((i) => i.status === "held") ?? [];
  const auto = items?.filter((i) => i.status === "auto-resolved") ?? [];

  const card = (item: DuplicateItem): JSX.Element => (
    <div className="card" key={item.eventKey} data-testid={`duplicate-${item.eventKey}`}>
      <div className="row">
        <div className="field">
          <label>New event</label>
          <strong>{item.event.title}</strong>
          <div className="muted">
            {item.event.dateText} · {item.event.placeName ?? "no place"}
          </div>
          <p>{item.event.description}</p>
          <div className="muted">“{item.event.sourceText.slice(0, 200)}”</div>
        </div>
        <div className="field">
          <label>Closest published event</label>
          {item.match ? (
            <>
              <strong>{item.match.title}</strong>
              <div className="muted">
                {item.match.dateText ?? item.match.date} · {item.match.placeName} ·{" "}
                {item.match.sourceId}
              </div>
              <p>{item.match.description}</p>
              <div className="muted">“{(item.match.quote ?? "").slice(0, 200)}”</div>
            </>
          ) : (
            <span className="muted">No longer on the map.</span>
          )}
        </div>
      </div>
      <p className="muted" data-testid="duplicate-odds">
        Jev: {pct(item.pSame)} the same event · {pct(item.pDistinct)} a distinct one
      </p>
      <div className="row" style={{ gap: "0.5rem" }}>
        <button
          className="primary"
          disabled={busy[item.eventKey]}
          onClick={() => void resolve(item.eventKey, "approve")}
        >
          {item.status === "held" ? "Different event — publish" : "Overturn — publish it"}
        </button>
        {item.status === "held" && (
          <button
            className="danger"
            disabled={busy[item.eventKey]}
            onClick={() => void resolve(item.eventKey, "dismiss")}
          >
            Duplicate — leave out
          </button>
        )}
      </div>
    </div>
  );

  return (
    <main className="container">
      <h1>Duplicates</h1>
      <p className="muted">
        Events the pipeline did not publish because they may be the same as one already
        on the map. <strong>Held</strong> ones need a decision; <strong>auto-resolved</strong>{" "}
        ones were judged duplicates with confidence and left off — overturn any that are
        wrong.
      </p>

      {error && (
        <div className="card" style={{ borderColor: "var(--danger)" }}>
          {error}
        </div>
      )}
      {!error && !items && <p>Loading…</p>}

      {items && (
        <>
          <h2>Held for review ({held.length})</h2>
          {held.length === 0 && <p className="muted">Nothing waiting.</p>}
          {held.map(card)}

          <h2>Auto-resolved as duplicates ({auto.length})</h2>
          {auto.length === 0 && <p className="muted">None.</p>}
          {auto.map(card)}
        </>
      )}
    </main>
  );
}
