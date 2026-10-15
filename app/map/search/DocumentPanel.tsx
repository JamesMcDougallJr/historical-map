"use client";

// What clicking a document (or a passage) does: a panel, not the PDF
// (plans/21, decision (c)). It keeps the user on the map with the context —
// the other matching paragraphs and the document's events — a glance away,
// and the page link is right there on each paragraph.

import { useEffect, useRef, useState } from "react";
import { formatDate } from "../utils/date-utils";
import { fetchDocument, type DocumentPanelData } from "./search-client";
import { SearchPanel } from "./SearchPanel";
import type { SearchLayout } from "./SearchBox";
import { Snippet } from "./Snippet";

/** "p.43¶2" → 43; text and HTML anchors have no page. */
export function pageOf(anchor: string | null | undefined): number | null {
  const m = anchor ? /^p\.(\d+)/.exec(anchor) : null;
  return m ? Number(m[1]) : null;
}

export function DocumentPanel({
  layout,
  documentId,
  query,
  focusSeq,
  focusAnchor = null,
  sources,
  onShowEvent,
  onShowAll,
  onClose,
}: {
  layout: SearchLayout;
  documentId: string;
  /** The current search, for the "matching passages" section. */
  query: string | null;
  /** A passage to scroll to and highlight (the passage action). */
  focusSeq: number | null;
  /** Or the same, by anchor — a quote-matched event's "from the source" link. */
  focusAnchor?: string | null;
  sources: ReadonlyMap<string, { name: string; color?: string }>;
  onShowEvent(eventId: string, locationId: string): void;
  onShowAll(documentId: string, title: string): void;
  onClose(): void;
}): JSX.Element {
  const [data, setData] = useState<DocumentPanelData | null>(null);
  const [error, setError] = useState(false);
  const focusRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(false);
    fetchDocument(documentId, query, controller.signal)
      .then(setData)
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [documentId, query]);

  const focusedSeq =
    focusSeq ??
    data?.passages.find((p) => p.anchor === focusAnchor)?.seq ??
    null;
  useEffect(() => {
    if (data && focusedSeq !== null) {
      focusRef.current?.scrollIntoView({ block: "center" });
    }
  }, [data, focusedSeq]);

  const title = data?.title ?? (error ? "Document unavailable" : "Loading…");
  const color = data ? sources.get(data.sourceId)?.color : undefined;
  const sourceUrl = `/api/documents/${encodeURIComponent(documentId)}/source`;

  return (
    <SearchPanel
      layout={layout}
      title={title}
      onClose={onClose}
      testId="document-panel"
    >
      {data && (
        <div className="px-4 py-3 space-y-5 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span
              className="inline-flex items-center gap-1.5 text-slate-600 dark:text-slate-300"
              data-testid="document-panel-source"
            >
              {color && (
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: color }}
                  aria-hidden
                />
              )}
              {data.sourceName}
            </span>
            <a
              href={sourceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="search-touch-target inline-flex items-center rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              data-testid="document-panel-open-original"
            >
              Open original ↗
            </a>
          </div>

          {query && (
            <section aria-labelledby="doc-passages-h">
              <h3
                id="doc-passages-h"
                className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Matching passages ({data.passages.length})
              </h3>
              {data.passages.length === 0 ? (
                <p className="text-slate-500">
                  No paragraph matches “{query}”.
                </p>
              ) : (
                <ol className="space-y-2">
                  {data.passages.map((p) => {
                    const focused = p.seq === focusedSeq;
                    const page = pageOf(p.anchor);
                    return (
                      <li
                        key={p.seq}
                        ref={focused ? focusRef : undefined}
                        data-testid={`document-passage-${p.seq}`}
                        data-focused={focused ? "true" : undefined}
                        className={`rounded-lg border p-2.5 ${
                          focused
                            ? "search-passage-focus border-amber-400 bg-amber-50"
                            : "border-slate-200 dark:border-slate-700"
                        }`}
                      >
                        <p className="text-slate-700 dark:text-slate-200">
                          <Snippet text={p.snippet} />
                        </p>
                        <div className="mt-1.5 flex items-center gap-3 text-xs">
                          {page !== null ? (
                            <a
                              href={`${sourceUrl}#page=${page}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-700 underline"
                              data-testid="document-passage-page"
                            >
                              {p.anchor} ↗
                            </a>
                          ) : (
                            <span className="text-slate-500">{p.anchor}</span>
                          )}
                          {p.eventIds.length > 0 && (
                            <button
                              type="button"
                              className="search-touch-target font-medium text-blue-700 underline"
                              data-testid="document-passage-show-event"
                              onClick={() => {
                                const event = data.events.find(
                                  (e) => e.id === p.eventIds[0],
                                );
                                if (event)
                                  onShowEvent(event.id, event.locationId);
                              }}
                            >
                              Show event
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
            </section>
          )}

          <section aria-labelledby="doc-events-h">
            <div className="mb-2 flex items-center justify-between">
              <h3
                id="doc-events-h"
                className="text-xs font-semibold uppercase tracking-wide text-slate-500"
              >
                Events from this document
              </h3>
              {data.events.length > 0 && (
                <button
                  type="button"
                  className="search-touch-target rounded-md bg-blue-600 px-2.5 py-1 text-xs font-medium text-white"
                  data-testid="document-panel-show-all"
                  onClick={() => onShowAll(data.id, data.title ?? "Document")}
                >
                  Show all on map
                </button>
              )}
            </div>
            {data.events.length === 0 ? (
              // Text matched but nothing reached the map — say exactly that
              // rather than show an empty list (the failure the plan's
              // "filter to its events" option would have had).
              <p
                className="text-slate-500"
                data-testid="document-panel-no-events"
              >
                No published events from this document yet. Its text is
                searchable, but nothing extracted from it has reached the map —
                extraction may not have run, or its events are still in review.
              </p>
            ) : (
              <ul className="divide-y divide-slate-100 dark:divide-slate-800">
                {data.events.map((e) => (
                  <li key={e.id}>
                    <button
                      type="button"
                      className="search-touch-target flex w-full items-baseline justify-between gap-3 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
                      data-testid="document-panel-event"
                      onClick={() => onShowEvent(e.id, e.locationId)}
                    >
                      <span className="font-medium text-slate-900 dark:text-slate-100">
                        {e.title}
                      </span>
                      <span className="shrink-0 text-xs text-slate-500">
                        {formatDate(e.date, e.datePrecision)}
                        {e.anchor ? ` · ${e.anchor}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}
      {error && (
        <p className="px-4 py-3 text-sm text-slate-500">
          This document couldn’t be loaded.
        </p>
      )}
    </SearchPanel>
  );
}
