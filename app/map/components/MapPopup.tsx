"use client";

import { useState, useMemo, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { HistoricalLocation, HistoricalEvent } from "../types";
import { getYear, sortByDate, groupByYear } from "../utils/date-utils";
import { EventCard } from "./EventCard";
import { EventTabs } from "./EventTabs";
import { EventPagination } from "./EventPagination";
import { EVENTS_PER_PAGE } from "../constants";

interface MapPopupProps {
  location: HistoricalLocation | null;
  onClose: () => void;
  isPinned?: boolean;
  onHeaderMouseDown?: (e: React.MouseEvent) => void;
  acknowledgedIds?: Set<string>;
  onAcknowledge?: (eventId: string) => void;
}

export function MapPopup({
  location,
  onClose,
  isPinned,
  onHeaderMouseDown,
  acknowledgedIds,
  onAcknowledge,
}: MapPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  /**
   * Which year/page the user picked, and the location it was picked for.
   *
   * Tagged with the location id so the choice can be *derived* during render
   * rather than reset from an effect. An effect runs after the first paint for
   * a new location, so the tab selection would still be pointing at the
   * previous pin's year for one frame — long enough to render an empty event
   * list before correcting itself.
   */
  const [selection, setSelection] = useState<{
    locationId: string;
    year: string;
    page: number;
  } | null>(null);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia("(max-width: 767px)");
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Sort events and group by year
  const sortedEvents = useMemo(() => {
    if (!location) return [];
    return sortByDate(location.events);
  }, [location]);

  const eventsByYear = useMemo(() => {
    return groupByYear(sortedEvents);
  }, [sortedEvents]);

  const years = useMemo(() => {
    return Array.from(eventsByYear.keys()).sort();
  }, [eventsByYear]);

  // The selection applies only to the location it was made on; any other
  // location falls back to its own first year, computed in the same render
  // that receives it. No effect, so no intermediate empty frame.
  const locationId = location?.id ?? "";
  // Only honour the selection if its year still exists — the timeline can
  // filter the year the user was on out from under them.
  const selectionApplies =
    selection?.locationId === locationId && eventsByYear.has(selection.year);
  const activeYear = selectionApplies ? selection.year : (years[0] ?? "");

  // Get events for current year
  const currentYearEvents = useMemo(() => {
    return eventsByYear.get(activeYear) ?? [];
  }, [eventsByYear, activeYear]);

  // Pagination
  const totalPages = Math.ceil(currentYearEvents.length / EVENTS_PER_PAGE);
  const currentPage = selectionApplies
    ? Math.min(selection.page, Math.max(0, totalPages - 1))
    : 0;
  const paginatedEvents = useMemo(() => {
    const start = currentPage * EVENTS_PER_PAGE;
    return currentYearEvents.slice(start, start + EVENTS_PER_PAGE);
  }, [currentYearEvents, currentPage]);

  // Handle year change
  const handleYearChange = (year: string) => {
    setSelection({ locationId, year, page: 0 });
  };

  // Handle page change
  const handlePageChange = (page: number) => {
    setSelection({ locationId, year: activeYear, page });
  };

  // A pin is on the map because it has events, so a popup with none is not a
  // state worth representing. Rendering nothing — rather than an empty shell
  // that fills in a frame later — means no ordering of renders can produce the
  // flash of an empty popup, whatever upstream hands us.
  if (!location || location.events.length === 0) return null;

  const header = (
    <div
      className={`px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 text-white ${isPinned ? "md:cursor-grab md:active:cursor-grabbing select-none" : ""}`}
      onMouseDown={isPinned ? onHeaderMouseDown : undefined}
    >
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-base md:text-sm">{location.name}</h3>
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          onClick={onClose}
          className="p-2 -m-1 hover:bg-white/20 rounded transition-colors"
          aria-label="Close popup"
        >
          <svg
            className="w-5 h-5 md:w-4 md:h-4"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          </svg>
        </button>
      </div>
      <p className="text-sm text-white/80">
        {location.events.length} event
        {location.events.length !== 1 ? "s" : ""}
      </p>
    </div>
  );

  const content = (
    <div className="p-4">
      <EventTabs
        years={years}
        activeYear={activeYear}
        onYearChange={handleYearChange}
      />
      <div className="space-y-4">
        {paginatedEvents.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            isAcknowledged={acknowledgedIds?.has(event.id)}
            onAcknowledge={onAcknowledge}
          />
        ))}
      </div>
      <EventPagination
        currentPage={currentPage}
        totalPages={totalPages}
        onPageChange={handlePageChange}
      />
    </div>
  );

  return (
    <>
      {/* Desktop: positioned overlay popup.
          The height cap lives on the body, not the card, so the display utility
          stays `md:block`. Changing it to `md:flex` made a stale CSS chunk (see
          CLAUDE.md) collapse the card to display:none — `hidden` with nothing to
          override it. Capping the body instead degrades to "uncapped popup"
          rather than "no popup".
          --popup-body-max-h is set by MapView's placement effect to the room
          actually available beside the pin, less the header. */}
      <div
        ref={popupRef}
        className="hidden md:block w-96 max-w-[90vw] bg-white dark:bg-neutral-800 rounded-xl shadow-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden"
      >
        {header}
        <div className="overflow-y-auto max-h-[var(--popup-body-max-h,60vh)]">
          {content}
        </div>
      </div>

      {/* Mobile: bottom sheet modal (portaled to body to escape OL overlay) */}
      {isMobile &&
        createPortal(
          <div
            className="fixed inset-0 z-[9999] flex flex-col bg-black/50"
            onClick={(e) => {
              if (e.target === e.currentTarget) onClose();
            }}
          >
            <div className="mt-auto max-h-[85vh] flex flex-col bg-white dark:bg-neutral-800 rounded-t-2xl overflow-hidden animate-slide-up">
              {header}
              <div className="overflow-y-auto">{content}</div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
