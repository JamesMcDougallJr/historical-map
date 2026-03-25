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
}

export function MapPopup({
  location,
  onClose,
  isPinned,
  onHeaderMouseDown,
}: MapPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [activeYear, setActiveYear] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(0);
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

  // Reset state when location changes
  useEffect(() => {
    if (location && years.length > 0) {
      setActiveYear(years[0] ?? "");
      setCurrentPage(0);
    }
  }, [location, years]);

  // Get events for current year
  const currentYearEvents = useMemo(() => {
    return eventsByYear.get(activeYear) ?? [];
  }, [eventsByYear, activeYear]);

  // Pagination
  const totalPages = Math.ceil(currentYearEvents.length / EVENTS_PER_PAGE);
  const paginatedEvents = useMemo(() => {
    const start = currentPage * EVENTS_PER_PAGE;
    return currentYearEvents.slice(start, start + EVENTS_PER_PAGE);
  }, [currentYearEvents, currentPage]);

  // Handle year change
  const handleYearChange = (year: string) => {
    setActiveYear(year);
    setCurrentPage(0);
  };

  // Handle page change
  const handlePageChange = (page: number) => {
    setCurrentPage(page);
  };

  if (!location) return null;

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
      {location.events.length === 0 ? (
        <p className="text-neutral-500 dark:text-neutral-400 text-sm text-center py-4">
          No events at this location yet.
        </p>
      ) : (
        <>
          <EventTabs
            years={years}
            activeYear={activeYear}
            onYearChange={handleYearChange}
          />
          <div className="space-y-4">
            {paginatedEvents.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
          </div>
          <EventPagination
            currentPage={currentPage}
            totalPages={totalPages}
            onPageChange={handlePageChange}
          />
        </>
      )}
    </div>
  );

  return (
    <>
      {/* Desktop: positioned overlay popup */}
      <div
        ref={popupRef}
        className="hidden md:block w-80 bg-white dark:bg-neutral-800 rounded-xl shadow-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden"
        onMouseEnter={(e) => e.stopPropagation()}
      >
        {header}
        {content}
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
