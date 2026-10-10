"use client";

// /map's page shell around MapView: the search bar, what clicking each kind
// of result does, the panels, and the URL state (plans/21-search-ui.md).
//
// Everything search-specific lives here, never in MapView — MapView is shared
// with the MCP App (CLAUDE.md), which gets no search bar and must not grow.
// The two talk through MapView's imperative handle (showEvent, showLocation,
// focusGroup, focusLocations) plus three optional props: the lifted timeline,
// the highlight set, and the pulsed pin.
//
// Every action goes through one dispatcher, `activate`, so anything later
// keyed on "what did the user find" (plans/19, gamification) has exactly one
// place to hook in.

import { createMapClient } from "@historical-map/api-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  EventGroup,
  EventLayer,
  EventHit,
  HistoricalEvent,
  HistoricalLocation,
  PassageHit,
  SearchHit,
} from "../types";
import { MapView, type MapViewHandle } from "../components/MapView";
import { DocumentPanel } from "./DocumentPanel";
import { fetchDocumentEvents } from "./search-client";
import { hitKey, SearchBox, useSearchLayout } from "./SearchBox";
import { SequencePanel } from "./SequencePanel";
import { useSearch } from "./useSearch";

const mapClient = createMapClient({
  apiKey: process.env["NEXT_PUBLIC_MAP_API_KEY"],
});

type Panel =
  | { kind: "document"; documentId: string; focusSeq: number | null }
  | { kind: "sequence"; groupId: string; title: string }
  | null;

function readUrl(): { q: string; hit: string | null } {
  const params = new URLSearchParams(window.location.search);
  return { q: params.get("q") ?? "", hit: params.get("hit") };
}

function writeUrl(q: string, hit: string | null, push: boolean): void {
  const params = new URLSearchParams(window.location.search);
  if (q) params.set("q", q);
  else params.delete("q");
  if (hit) params.set("hit", hit);
  else params.delete("hit");
  const qs = params.toString();
  const url = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

export interface MapWithSearchProps {
  locations: HistoricalLocation[];
  initialEventLayers: EventLayer[];
  eventGroups: EventGroup[];
  onRefresh?: () => void;
}

export function MapWithSearch({
  locations,
  initialEventLayers,
  eventGroups,
  onRefresh,
}: MapWithSearchProps): JSX.Element {
  const mapRef = useRef<MapViewHandle>(null);
  const layout = useSearchLayout();

  // The timeline, lifted out of MapView: search follows it.
  const [timelineRange, setTimelineRange] = useState<[number, number]>([
    1776, 2020,
  ]);
  const [timelineEnabled, setTimelineEnabled] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Off by default and deliberately not remembered across sessions.
  const [limitToView, setLimitToView] = useState(false);

  const getViewFilter = useCallback(
    () => mapRef.current?.getViewFilter() ?? null,
    [],
  );
  const search = useSearch({
    timeline: timelineEnabled ? timelineRange : null,
    limitToView,
    getViewFilter,
  });

  const [listOpen, setListOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>(null);
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  const [activeHit, setActiveHit] = useState<SearchHit | null>(null);

  const sources = useMemo(() => {
    const map = new Map<string, { name: string; color?: string }>();
    for (const layer of initialEventLayers) {
      for (const id of layer.sourceIds ?? [layer.id]) {
        map.set(id, {
          name: layer.name,
          ...(layer.color ? { color: layer.color } : {}),
        });
      }
    }
    return map;
  }, [initialEventLayers]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const clearFocus = useCallback(() => {
    mapRef.current?.clearFocus();
    setFocusLabel(null);
  }, []);

  /** Fly to an event known only by id + location id (panels, passages). */
  const showEventById = useCallback(
    async (eventId: string, locationId: string) => {
      const location = await mapClient
        .getLocation(locationId)
        .catch(() => null);
      if (!location) return;
      const event = location.events.find((e) => e.id === eventId);
      mapRef.current?.showEvent({
        locationId: location.id,
        locationName: location.name,
        coordinates: location.coordinates,
        eventId,
        sourceId: event?.sourceId ?? null,
      });
    },
    [],
  );

  const showEventHit = useCallback((hit: EventHit) => {
    mapRef.current?.showEvent({
      locationId: hit.locationId,
      locationName: hit.locationName,
      coordinates: hit.coordinates,
      eventId: hit.id,
      sourceId: hit.sourceId,
    });
  }, []);

  /** The one dispatcher every search action goes through. */
  const activate = useCallback(
    (hit: SearchHit, opts: { push?: boolean } = {}) => {
      setListOpen(false);
      setActiveHit(null);
      writeUrl(search.input, hitKey(hit), opts.push ?? true);
      switch (hit.kind) {
        case "event":
          setPanel(null);
          showEventHit(hit);
          break;
        case "location":
          setPanel(null);
          mapRef.current?.showLocation({
            locationId: hit.id,
            locationName: hit.title,
            coordinates: hit.coordinates,
          });
          break;
        case "sequence":
          mapRef.current?.closePopup();
          mapRef.current?.focusGroup(hit.id, hit.bbox);
          setFocusLabel(hit.title);
          setPanel({ kind: "sequence", groupId: hit.id, title: hit.title });
          break;
        case "document":
          setPanel({ kind: "document", documentId: hit.id, focusSeq: null });
          break;
        case "passage":
          setPanel({
            kind: "document",
            documentId: hit.documentId,
            focusSeq: Number(hit.id.split(":").pop()),
          });
          break;
      }
    },
    [search.input, showEventHit],
  );

  /** Back (Esc or the browser's back button): the result list, query intact. */
  const backToList = useCallback(() => {
    setPanel(null);
    clearFocus();
    mapRef.current?.closePopup();
    setListOpen(true);
  }, [clearFocus]);

  useEffect(() => {
    const onPop = () => {
      const { q, hit } = readUrl();
      if (!hit && q) backToList();
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [backToList]);

  // Esc with an action showing (and the list closed) goes back to the list.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || listOpen) return;
      if (!panel && !readUrl().hit) return;
      writeUrl(search.input, null, false);
      backToList();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [listOpen, panel, search.input, backToList]);

  // A shared link — /map?q=…&hit=kind:id — reproduces the same state.
  // Marked done only once a response is applied: under Strict Mode the first
  // mount's request is aborted by the simulated unmount, and a guard set
  // up front would then skip the remount's retry.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    const { q, hit } = readUrl();
    if (!q) {
      restoredRef.current = true;
      return;
    }
    let cancelled = false;
    void search.submit(q).then((res) => {
      if (cancelled || !res) return;
      restoredRef.current = true;
      const found = hit ? res.hits.find((h) => hitKey(h) === hit) : undefined;
      if (found) activate(found, { push: false });
      else setListOpen(true);
    });
    return () => {
      cancelled = true;
    };
    // Once, on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onOpenQuotePassage = useCallback(
    (hit: EventHit) => {
      if (!hit.quotePassage) return;
      setListOpen(false);
      writeUrl(search.input, hitKey(hit), true);
      // Which paragraph: the document panel locates it by anchor among the
      // matching passages, so pass the seq we know from the passage id when
      // there is one — for a folded quote, find it by anchor once loaded.
      setPanel({
        kind: "document",
        documentId: hit.quotePassage.documentId,
        focusSeq: null,
      });
      setQuoteAnchor(hit.quotePassage.anchor);
    },
    [search.input],
  );
  const [quoteAnchor, setQuoteAnchor] = useState<string | null>(null);

  const onShowPassageEvent = useCallback(
    async (hit: PassageHit) => {
      setListOpen(false);
      const eventId = hit.eventIds[0];
      if (!eventId) return;
      const { results } = await fetchDocumentEvents(hit.documentId).catch(
        () => ({
          results: [],
        }),
      );
      const found = results.find((r) => r.event.id === eventId);
      if (found) void showEventById(eventId, found.location.id);
    },
    [showEventById],
  );

  const onShowAll = useCallback(async (documentId: string, title: string) => {
    const { results } = await fetchDocumentEvents(documentId).catch(() => ({
      results: [],
    }));
    const byId = new Map(
      results.map((r) => [r.location.id, r.location.coordinates]),
    );
    mapRef.current?.closePopup();
    mapRef.current?.focusLocations(
      Array.from(byId.keys()),
      Array.from(byId.values()),
    );
    setFocusLabel(title);
  }, []);

  const onShowMember = useCallback(
    (event: HistoricalEvent, location: HistoricalLocation) => {
      mapRef.current?.showEvent({
        locationId: location.id,
        locationName: location.name,
        coordinates: location.coordinates,
        eventId: event.id,
        sourceId: event.sourceId ?? null,
      });
    },
    [],
  );

  const closePanel = useCallback(() => {
    if (panel?.kind === "sequence") clearFocus();
    setPanel(null);
    setQuoteAnchor(null);
    writeUrl(search.input, null, false);
  }, [panel, clearFocus, search.input]);

  // ── Highlight + pulse ────────────────────────────────────────────────────
  const highlight = listOpen ? search.highlight : null;
  const pulseLocationId =
    listOpen && activeHit
      ? activeHit.kind === "event"
        ? activeHit.locationId
        : activeHit.kind === "location"
          ? activeHit.id
          : null
      : null;

  const searchBox = (
    <div className="flex flex-col gap-2">
      <SearchBox
        search={search}
        open={listOpen}
        onOpenChange={setListOpen}
        timeline={{ enabled: timelineEnabled, range: timelineRange }}
        onOpenTimeline={() => setTimelineOpen(true)}
        onSetTimeline={(range) => {
          setTimelineRange(range);
          setTimelineEnabled(true);
        }}
        limitToView={limitToView}
        onLimitToViewChange={setLimitToView}
        sources={sources}
        onActivate={activate}
        onOpenQuotePassage={onOpenQuotePassage}
        onShowPassageEvent={onShowPassageEvent}
        onActiveHitChange={setActiveHit}
      />
      {focusLabel && (
        <span
          className="search-touch-target inline-flex w-fit items-center gap-2 rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white shadow-lg"
          data-testid="search-focus-chip"
        >
          Showing: {focusLabel}
          <button
            type="button"
            aria-label={`Stop showing ${focusLabel}`}
            className="text-white/80 hover:text-white"
            data-testid="search-focus-chip-clear"
            onClick={() => {
              clearFocus();
              if (panel?.kind === "sequence") setPanel(null);
            }}
          >
            ×
          </button>
        </span>
      )}
    </div>
  );

  return (
    <div className="relative h-full w-full">
      <MapView
        ref={mapRef}
        locations={locations}
        initialEventLayers={initialEventLayers}
        eventGroups={eventGroups}
        {...(onRefresh ? { onRefresh } : {})}
        timelineRange={timelineRange}
        onTimelineRangeChange={setTimelineRange}
        timelineEnabled={timelineEnabled}
        onTimelineEnabledChange={setTimelineEnabled}
        timelineOpen={timelineOpen}
        onTimelineOpenChange={setTimelineOpen}
        highlightLocationIds={highlight?.ids ?? null}
        highlightDimsOthers={highlight?.dimOthers ?? true}
        pulseLocationId={pulseLocationId}
        topLeftSlot={searchBox}
      />
      {panel?.kind === "document" && (
        <DocumentPanel
          layout={layout}
          documentId={panel.documentId}
          query={search.input.trim() || null}
          focusSeq={panel.focusSeq}
          focusAnchor={panel.focusSeq === null ? quoteAnchor : null}
          sources={sources}
          onShowEvent={(eventId, locationId) =>
            void showEventById(eventId, locationId)
          }
          onShowAll={(id, title) => void onShowAll(id, title)}
          onClose={closePanel}
        />
      )}
      {panel?.kind === "sequence" && (
        <SequencePanel
          layout={layout}
          groupId={panel.groupId}
          title={panel.title}
          onShowMember={onShowMember}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
