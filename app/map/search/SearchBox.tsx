"use client";

// The /map search bar (plans/21-search-ui.md): one input, results grouped by
// kind, each row obvious at a glance.
//
// Accessibility is hand-built, not borrowed from a library: the WAI-ARIA APG
// "combobox with listbox popup" pattern — an input with role="combobox",
// aria-expanded/aria-controls/aria-activedescendant, and a role="listbox"
// whose sections are role="group"s labelled by their headers. The active
// option is one index across every section, skipping headers.
//
// Lives in the page shell, never in MapView: MapView is shared with the MCP
// App, where Claude is the search interface and the bundle stays small.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DocumentHit,
  EventHit,
  LocationHit,
  PassageHit,
  SearchHit,
  SearchKind,
  SequenceHit,
} from "../types";
import { formatDate } from "../utils/date-utils";
import { Snippet } from "./Snippet";
import type { SearchState } from "./useSearch";

export type SearchLayout = "desktop" | "tablet" | "phone";

/** Chosen by viewport width, never user agent (≥1024 / 640–1023 / <640). */
export function useSearchLayout(): SearchLayout {
  const [layout, setLayout] = useState<SearchLayout>("desktop");
  useEffect(() => {
    const wide = window.matchMedia("(min-width: 1024px)");
    const mid = window.matchMedia("(min-width: 640px)");
    const update = () =>
      setLayout(wide.matches ? "desktop" : mid.matches ? "tablet" : "phone");
    update();
    wide.addEventListener("change", update);
    mid.addEventListener("change", update);
    return () => {
      wide.removeEventListener("change", update);
      mid.removeEventListener("change", update);
    };
  }, []);
  return layout;
}

/** Height actually visible above an on-screen keyboard. */
function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setHeight(vv.height);
    update();
    vv.addEventListener("resize", update);
    return () => vv.removeEventListener("resize", update);
  }, []);
  return height;
}

const SECTION_ORDER: SearchKind[] = [
  "event",
  "sequence",
  "location",
  "person",
  "document",
  "passage",
];
const SECTION_LABEL: Record<SearchKind, string> = {
  event: "Events",
  sequence: "Sequences",
  location: "Places",
  person: "People",
  document: "Documents",
  passage: "Passages",
};
const KIND_LABEL: Record<SearchKind, string> = {
  event: "Event",
  sequence: "Sequence",
  location: "Place",
  person: "Person",
  document: "Document",
  passage: "Passage",
};

export const hitKey = (hit: Pick<SearchHit, "kind" | "id">) =>
  `${hit.kind}:${hit.id}`;

function yearOf(iso: string): string {
  return iso.slice(0, 4).replace(/^0+(?=\d)/, "");
}

function yearSpan(range: [string, string] | null): string {
  if (!range) return "";
  const [a, b] = [yearOf(range[0]), yearOf(range[1])];
  return a === b ? a : `${a}–${b}`;
}

function KindIcon({ kind }: { kind: SearchKind }): JSX.Element {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (kind) {
    case "event":
      return (
        <svg {...common}>
          <path d="M12 21s-6-5.6-6-11a6 6 0 1 1 12 0c0 5.4-6 11-6 11z" />
          <circle cx="12" cy="10" r="2" />
        </svg>
      );
    case "sequence":
      return (
        <svg {...common}>
          <circle cx="5" cy="18" r="2" />
          <circle cx="12" cy="6" r="2" />
          <circle cx="19" cy="15" r="2" />
          <path d="M6.5 16.5 10.5 7.5M13.6 7.3l3.9 6.4" />
        </svg>
      );
    case "location":
      return (
        <svg {...common}>
          <path d="M3 21h18M5 21V10l7-5 7 5v11" />
          <path d="M10 21v-5h4v5" />
        </svg>
      );
    case "person":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-7 8-7s8 3 8 7" />
        </svg>
      );
    case "document":
      return (
        <svg {...common}>
          <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
          <path d="M14 3v5h5M8 13h8M8 17h6" />
        </svg>
      );
    case "passage":
      return (
        <svg {...common}>
          <path d="M7 7h4v4c0 3-2 5-4 6M15 7h4v4c0 3-2 5-4 6" />
        </svg>
      );
  }
}

export interface SearchBoxProps {
  search: SearchState;
  open: boolean;
  onOpenChange(open: boolean): void;
  timeline: { enabled: boolean; range: [number, number] };
  onOpenTimeline(): void;
  onSetTimeline(range: [number, number]): void;
  limitToView: boolean;
  onLimitToViewChange(on: boolean): void;
  sources: ReadonlyMap<string, { name: string; color?: string }>;
  onActivate(hit: SearchHit): void;
  /** A quote-matched event's "from the source" anchor: the document panel at that paragraph. */
  onOpenQuotePassage(hit: EventHit): void;
  /** A passage row's inline "show event". */
  onShowPassageEvent(hit: PassageHit): void;
  /** The focused row, for pulsing its pin. */
  onActiveHitChange(hit: SearchHit | null): void;
}

export function SearchBox({
  search,
  open,
  onOpenChange,
  timeline,
  onOpenTimeline,
  onSetTimeline,
  limitToView,
  onLimitToViewChange,
  sources,
  onActivate,
  onOpenQuotePassage,
  onShowPassageEvent,
  onActiveHitChange,
}: SearchBoxProps): JSX.Element {
  const layout = useSearchLayout();
  const viewportHeight = useVisualViewportHeight();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [phoneOpen, setPhoneOpen] = useState(false);
  // Phone only: the list collapsed to a peek so the highlighted map shows.
  const [phonePeek, setPhonePeek] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [submitted, setSubmitted] = useState(false);
  const res = search.response;

  // ── Options: one flat list across sections (top hit first) ──────────────
  const { sections, options, topHit } = useMemo(() => {
    const hits = res?.hits ?? [];
    const top = res?.topHit
      ? (hits.find(
          (h) => h.kind === res.topHit!.kind && h.id === res.topHit!.id,
        ) ?? null)
      : null;
    const flat: Array<{ hit: SearchHit; top: boolean }> = [];
    if (top) flat.push({ hit: top, top: true });
    const grouped = SECTION_ORDER.map((kind) => ({
      kind,
      hits: hits.filter((h) => h.kind === kind),
    })).filter((g) => g.hits.length > 0);
    for (const g of grouped)
      for (const hit of g.hits) flat.push({ hit, top: false });
    return { sections: grouped, options: flat, topHit: top };
  }, [res]);

  // A new result set resets the keyboard selection.
  useEffect(() => setActiveIndex(-1), [res]);
  useEffect(() => {
    onActiveHitChange(
      activeIndex >= 0 ? (options[activeIndex]?.hit ?? null) : null,
    );
  }, [activeIndex, options, onActiveHitChange]);

  // ⌘K / Ctrl+K / "/" focus the input — "/" only when not already typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable);
      if (
        (e.key === "k" && (e.metaKey || e.ctrlKey)) ||
        (e.key === "/" && !typing)
      ) {
        e.preventDefault();
        if (layout === "phone") setPhoneOpen(true);
        inputRef.current?.focus();
        onOpenChange(true);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [layout, onOpenChange]);

  // Phone: focus the input once the full-screen view mounts.
  useEffect(() => {
    if (phoneOpen) inputRef.current?.focus();
  }, [phoneOpen]);

  const activate = useCallback(
    (hit: SearchHit) => {
      // Dismiss the on-screen keyboard *before* flying, or the fly target
      // lands under it.
      inputRef.current?.blur();
      setPhoneOpen(false);
      onActivate(hit);
    },
    [onActivate],
  );

  const onKeyDown = async (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onOpenChange(true);
      setActiveIndex((i) => (options.length ? (i + 1) % options.length : -1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) =>
        options.length ? (i <= 0 ? options.length - 1 : i - 1) : -1,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      const active = activeIndex >= 0 ? options[activeIndex] : undefined;
      if (active) {
        activate(active.hit);
        return;
      }
      // No row chosen: a deliberate full search (hybrid once S3 exists).
      // Until then, Enter takes the top hit when the response has one.
      setSubmitted(true);
      onOpenChange(true);
      const result = await search.submit();
      if (result?.topHit) {
        const top = result.hits.find(
          (h) => h.kind === result.topHit!.kind && h.id === result.topHit!.id,
        );
        if (top) activate(top);
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      onOpenChange(false);
      setActiveIndex(-1);
      inputRef.current?.blur();
      setPhoneOpen(false);
    }
  };

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (activeIndex < 0) return;
    document
      .getElementById(`search-opt-${activeIndex}`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const showList = open && search.input.trim().length > 0;
  const parsed = res?.parsed;
  const dateChip =
    parsed?.dateRange && parsed.rawDate
      ? `${parsed.dateRange[0] ?? "…"}–${parsed.dateRange[1] ?? "…"}`
      : null;
  const removeDate = () => {
    if (!parsed?.rawDate) return;
    const next = search.input
      .replace(parsed.rawDate, " ")
      .replace(/\s+/g, " ")
      .trim();
    search.setInput(next);
  };

  const listMaxHeight =
    layout === "phone"
      ? undefined
      : viewportHeight
        ? Math.max(200, viewportHeight - 210)
        : undefined;

  let optionIndex = 0;
  const renderOption = (hit: SearchHit, top: boolean) => {
    const index = optionIndex++;
    return (
      <ResultRow
        key={`${top ? "top:" : ""}${hitKey(hit)}`}
        id={`search-opt-${index}`}
        hit={hit}
        top={top}
        active={index === activeIndex}
        sources={sources}
        onMouseEnter={() => setActiveIndex(index)}
        onActivate={() => activate(hit)}
        onOpenQuotePassage={(h) => {
          inputRef.current?.blur();
          setPhoneOpen(false);
          onOpenQuotePassage(h);
        }}
        onShowPassageEvent={(h) => {
          inputRef.current?.blur();
          setPhoneOpen(false);
          onShowPassageEvent(h);
        }}
      />
    );
  };

  const list = showList ? (
    <div
      ref={listRef}
      className="search-results mt-2 overflow-y-auto rounded-xl bg-white/95 dark:bg-slate-900/95 shadow-xl border border-slate-200 dark:border-slate-700 backdrop-blur-sm"
      style={listMaxHeight ? { maxHeight: listMaxHeight } : undefined}
      data-testid="search-results"
    >
      {/* Messages first: the conflict and the slow-search hint explain an
          empty or slow list, so they sit above it. */}
      {parsed?.conflict === "timeline" && (
        <div
          className="p-3 text-sm text-amber-900 bg-amber-50 border-b border-amber-200"
          data-testid="search-conflict"
          role="status"
        >
          <p>
            {parsed.rawDate} is outside your timeline ({timeline.range[0]}–
            {timeline.range[1]}).
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="search-touch-target px-3 py-1.5 rounded-md bg-amber-600 text-white text-xs font-medium"
              data-testid="search-conflict-use-date"
              onClick={() => {
                const [lo, hi] = parsed.dateRange ?? [null, null];
                onSetTimeline([
                  lo ?? timeline.range[0],
                  hi ?? timeline.range[1],
                ]);
              }}
            >
              Search {parsed.rawDate}
            </button>
            <button
              type="button"
              className="search-touch-target px-3 py-1.5 rounded-md border border-amber-600 text-amber-800 text-xs font-medium"
              data-testid="search-conflict-ignore-date"
              onClick={removeDate}
            >
              Ignore the date
            </button>
          </div>
        </div>
      )}
      {search.slowHint && (
        <div
          className="flex items-start gap-2 p-3 text-sm text-slate-700 bg-sky-50 border-b border-sky-200"
          data-testid="search-slow-hint"
          role="status"
        >
          <p className="flex-1">
            {search.slowHint === "waiting"
              ? "Searching everything… "
              : "That search covered everything. "}
            <button
              type="button"
              className="font-semibold text-sky-700 underline"
              data-testid="search-slow-hint-timeline"
              onClick={onOpenTimeline}
            >
              Narrow by time
            </button>{" "}
            to speed this up.
          </p>
          <button
            type="button"
            className="search-touch-target -m-1 p-1 text-slate-500"
            aria-label="Dismiss"
            data-testid="search-slow-hint-dismiss"
            onClick={search.dismissSlowHint}
          >
            ×
          </button>
        </div>
      )}

      <div
        role="listbox"
        id="search-listbox"
        aria-label="Search results"
        className="py-1"
      >
        {topHit && (
          <div role="group" aria-labelledby="search-section-top">
            <div
              id="search-section-top"
              className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            >
              Top hit
            </div>
            {renderOption(topHit, true)}
          </div>
        )}
        {sections.map((section) => (
          <div
            key={section.kind}
            role="group"
            aria-labelledby={`search-section-${section.kind}`}
            data-testid={`search-section-${section.kind}`}
          >
            <div
              id={`search-section-${section.kind}`}
              className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500"
            >
              {SECTION_LABEL[section.kind]}
            </div>
            {section.hits.map((hit) => renderOption(hit, false))}
          </div>
        ))}
      </div>

      {res && res.hits.length === 0 && !parsed?.conflict && !search.loading && (
        <p
          className="px-3 py-4 text-sm text-slate-500"
          data-testid="search-empty"
        >
          No results for “{search.input.trim()}”.
        </p>
      )}
      {res && (!res.modes.documents || (submitted && !res.modes.semantic)) && (
        <div className="px-3 py-2 text-[11px] text-slate-500 border-t border-slate-200 dark:border-slate-700 space-y-0.5">
          {!res.modes.documents && (
            <p data-testid="search-documents-unavailable">
              Source text search unavailable
            </p>
          )}
          {submitted && !res.modes.semantic && (
            <p data-testid="search-semantic-unavailable">
              Search by meaning unavailable
            </p>
          )}
        </div>
      )}
    </div>
  ) : null;

  const chips = (
    <div className="mt-2 flex flex-wrap gap-2" data-testid="search-chips">
      {timeline.enabled && (
        // No ×: the timeline control owns this filter. Clicking opens it.
        <button
          type="button"
          className="search-touch-target inline-flex items-center gap-1.5 rounded-full bg-blue-600 text-white px-3 py-1 text-xs font-medium shadow"
          data-testid="search-timeline-chip"
          onClick={onOpenTimeline}
          aria-label={`Timeline ${timeline.range[0]}–${timeline.range[1]}, open timeline`}
        >
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            aria-hidden
          >
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          {timeline.range[0]}–{timeline.range[1]}
        </button>
      )}
      {dateChip && parsed?.conflict !== "timeline" && (
        <span
          className="search-touch-target inline-flex items-center gap-1 rounded-full bg-white/95 text-slate-800 px-3 py-1 text-xs font-medium shadow border border-slate-200"
          data-testid="search-date-chip"
        >
          {dateChip}
          <button
            type="button"
            className="ml-1 text-slate-500 hover:text-slate-800"
            aria-label={`Remove date ${dateChip}`}
            data-testid="search-date-chip-remove"
            onClick={removeDate}
          >
            ×
          </button>
        </span>
      )}
      {(open || limitToView) && search.input.trim() && (
        <button
          type="button"
          aria-pressed={limitToView}
          className={`search-touch-target inline-flex items-center rounded-full px-3 py-1 text-xs font-medium shadow border ${
            limitToView
              ? "bg-slate-800 text-white border-slate-800"
              : "bg-white/95 text-slate-700 border-slate-200"
          }`}
          data-testid="search-limit-to-view"
          onClick={() => onLimitToViewChange(!limitToView)}
        >
          Limit to view
        </button>
      )}
    </div>
  );

  const inputBox = (
    <div className="relative">
      <svg
        className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-slate-400"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls="search-listbox"
        aria-autocomplete="list"
        aria-activedescendant={
          activeIndex >= 0 ? `search-opt-${activeIndex}` : undefined
        }
        aria-label="Search events, places, sequences and sources"
        placeholder="Search events, places, sources…"
        autoComplete="off"
        spellCheck={false}
        data-testid="search-input"
        className="search-touch-target w-full rounded-xl bg-white/95 dark:bg-slate-900/95 pl-9 pr-16 py-2.5 text-sm text-slate-900 dark:text-slate-100 shadow-lg border border-slate-200 dark:border-slate-700 outline-none focus:ring-2 focus:ring-blue-500 backdrop-blur-sm"
        value={search.input}
        onChange={(e) => {
          setSubmitted(false);
          search.setInput(e.target.value);
          onOpenChange(true);
        }}
        onFocus={() => onOpenChange(true)}
        onKeyDown={onKeyDown}
      />
      <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-2">
        {search.loading && (
          <span
            className="block h-4 w-4 rounded-full border-2 border-slate-300 border-t-blue-600 animate-spin"
            data-testid="search-spinner"
            aria-label="Searching"
          />
        )}
        <kbd className="search-kbd-hint text-[10px] text-slate-400 border border-slate-300 rounded px-1">
          ⌘K
        </kbd>
      </div>
    </div>
  );

  if (layout === "phone") {
    return (
      <>
        <button
          type="button"
          className="search-touch-target flex items-center justify-center h-11 w-11 rounded-lg bg-white/90 text-slate-800 shadow-lg"
          aria-label="Search"
          data-testid="search-phone-button"
          data-layout={layout}
          onClick={() => {
            setPhoneOpen(true);
            onOpenChange(true);
          }}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
        </button>
        {phoneOpen && (
          <div
            className={`fixed inset-x-0 z-50 flex flex-col bg-slate-50 dark:bg-slate-950 p-3 ${
              phonePeek ? "bottom-0 rounded-t-2xl shadow-2xl" : "top-0"
            }`}
            style={{
              height: phonePeek ? "30dvh" : (viewportHeight ?? "100dvh"),
            }}
            data-testid="search-fullscreen"
            data-peek={phonePeek ? "true" : undefined}
          >
            <div className="flex items-center gap-2">
              <div className="flex-1">{inputBox}</div>
              <button
                type="button"
                className="search-touch-target px-2 text-sm text-slate-700"
                onClick={() => {
                  setPhoneOpen(false);
                  setPhonePeek(false);
                  onOpenChange(false);
                }}
              >
                Cancel
              </button>
            </div>
            {search.input.trim() && (
              <button
                type="button"
                className="search-touch-target mt-2 self-start rounded-full bg-slate-800 px-3 py-1 text-xs font-medium text-white"
                data-testid="search-phone-peek"
                onClick={() => {
                  inputRef.current?.blur();
                  setPhonePeek((p) => !p);
                }}
              >
                {phonePeek ? "Show list" : "Show on map"}
              </button>
            )}
            {chips}
            <div className="flex-1 min-h-0 flex flex-col">{list}</div>
          </div>
        )}
      </>
    );
  }

  return (
    <div
      className={layout === "desktop" ? "w-[26rem]" : "w-[calc(100vw-2rem)]"}
      data-testid="search-bar"
      data-layout={layout}
    >
      {inputBox}
      {chips}
      {list}
    </div>
  );
}

// ── Rows ────────────────────────────────────────────────────────────────────

interface ResultRowProps {
  id: string;
  hit: SearchHit;
  top: boolean;
  active: boolean;
  sources: ReadonlyMap<string, { name: string; color?: string }>;
  onMouseEnter(): void;
  onActivate(): void;
  onOpenQuotePassage(hit: EventHit): void;
  onShowPassageEvent(hit: PassageHit): void;
}

function ResultRow({
  id,
  hit,
  top,
  active,
  sources,
  onMouseEnter,
  onActivate,
  onOpenQuotePassage,
  onShowPassageEvent,
}: ResultRowProps): JSX.Element {
  const byMeaning =
    hit.matchedOn.length === 1 && hit.matchedOn[0] === "meaning";
  const quote =
    hit.kind === "event" &&
    hit.matchedOn.includes("quote") &&
    !hit.matchedOn.includes("body");
  const snippet =
    hit.kind === "event" && hit.quotePassage && quote
      ? hit.quotePassage.snippet
      : hit.snippet;

  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      data-testid="search-row"
      data-kind={hit.kind}
      data-hit={hitKey(hit)}
      data-top={top ? "true" : undefined}
      className={`search-touch-target group flex gap-3 px-3 py-2 cursor-pointer ${
        active
          ? "bg-blue-50 dark:bg-slate-800"
          : "hover:bg-slate-50 dark:hover:bg-slate-800/60"
      }`}
      onMouseEnter={onMouseEnter}
      // mousedown, not click: keeps focus on the input until we decide to blur.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onActivate}
    >
      <span className="mt-0.5 text-slate-500" data-testid="search-row-icon">
        <KindIcon kind={hit.kind} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span
            className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-500"
            data-testid="search-row-kind"
          >
            {KIND_LABEL[hit.kind]}
          </span>
          <span
            className="truncate text-sm font-medium text-slate-900 dark:text-slate-100"
            data-testid="search-row-title"
          >
            {hit.title}
          </span>
          {byMeaning && (
            <span
              className="shrink-0 rounded bg-violet-100 text-violet-700 px-1 text-[10px]"
              data-testid="search-row-meaning"
            >
              by meaning
            </span>
          )}
        </div>
        {snippet && (
          <p className="mt-0.5 line-clamp-2 text-xs text-slate-600 dark:text-slate-300">
            <Snippet text={snippet} />
          </p>
        )}
        {quote && (
          <p
            className="mt-0.5 text-[11px] text-slate-500"
            data-testid="search-row-quote"
          >
            from the source
            {hit.kind === "event" && hit.quotePassage && (
              <>
                {" · "}
                <button
                  type="button"
                  className="underline text-blue-700"
                  data-testid="search-row-quote-anchor"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenQuotePassage(hit);
                  }}
                >
                  {hit.quotePassage.anchor}
                </button>
              </>
            )}
          </p>
        )}
        {hit.kind === "passage" && hit.eventIds.length > 0 && (
          <button
            type="button"
            className="search-touch-target mt-1 text-[11px] font-medium text-blue-700 underline"
            data-testid="search-row-show-event"
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation();
              onShowPassageEvent(hit);
            }}
          >
            Show event
          </button>
        )}
      </div>
      <div
        className="w-28 shrink-0 text-right text-[11px] leading-snug text-slate-500"
        data-testid="search-row-context"
      >
        <RowContext hit={hit} sources={sources} />
      </div>
    </div>
  );
}

function RowContext({
  hit,
  sources,
}: {
  hit: SearchHit;
  sources: ReadonlyMap<string, { name: string; color?: string }>;
}): JSX.Element {
  switch (hit.kind) {
    case "event":
      return <EventContext hit={hit} sources={sources} />;
    case "sequence":
      return <SequenceContext hit={hit} />;
    case "location":
      return <LocationContext hit={hit} />;
    case "person":
      return (
        <span>
          {hit.eventCount} event{hit.eventCount === 1 ? "" : "s"}
          {hit.dateRange ? ` · ${yearSpan(hit.dateRange)}` : ""}
        </span>
      );
    case "document":
      return <DocumentContext hit={hit} sources={sources} />;
    case "passage":
      return (
        <span>
          {hit.anchor ? `${hit.anchor} · ` : ""}
          {hit.documentTitle}
        </span>
      );
  }
}

function EventContext({
  hit,
  sources,
}: {
  hit: EventHit;
  sources: ReadonlyMap<string, { name: string; color?: string }>;
}): JSX.Element {
  const color = hit.sourceId ? sources.get(hit.sourceId)?.color : undefined;
  return (
    <span className="flex flex-col items-end">
      {/* Dates always go through formatDate with their precision: a year-only
          event must read "1857", never "January 1, 1857". */}
      <span className="inline-flex items-center gap-1 font-medium text-slate-600">
        {color && (
          <span
            className="inline-block h-2 w-2 rounded-full"
            style={{ backgroundColor: color }}
            aria-hidden
          />
        )}
        <span data-testid="search-row-date">
          {formatDate(hit.date, hit.datePrecision, hit.dateText)}
        </span>
      </span>
      <span className="line-clamp-2">{hit.locationName}</span>
    </span>
  );
}

function SequenceContext({ hit }: { hit: SequenceHit }): JSX.Element {
  return (
    <span>
      {hit.memberCount} event{hit.memberCount === 1 ? "" : "s"}
      {hit.dateRange ? ` · ${yearSpan(hit.dateRange)}` : ""}
      {hit.membersInRange < hit.memberCount
        ? ` · ${hit.membersInRange} in range`
        : ""}
    </span>
  );
}

function LocationContext({ hit }: { hit: LocationHit }): JSX.Element {
  return (
    <span>
      {hit.eventCount} event{hit.eventCount === 1 ? "" : "s"}
      {hit.dateRange ? ` · ${yearSpan(hit.dateRange)}` : ""}
    </span>
  );
}

function DocumentContext({
  hit,
  sources,
}: {
  hit: DocumentHit;
  sources: ReadonlyMap<string, { name: string; color?: string }>;
}): JSX.Element {
  const parts: string[] = [];
  if (hit.bestAnchor) parts.push(hit.bestAnchor.replace(/¶\d+$/, ""));
  if (hit.matchCount)
    parts.push(`${hit.matchCount} match${hit.matchCount === 1 ? "" : "es"}`);
  const source = sources.get(hit.sourceId)?.name;
  if (source) parts.push(source);
  return <span>{parts.join(" · ")}</span>;
}
