'use client';

import { useState, useMemo, useEffect, useRef } from 'react';
import type { HistoricalLocation, HistoricalEvent } from '../types';
import { getYear, sortByDate, groupByYear } from '../utils/date-utils';
import { EventCard } from './EventCard';
import { EventTabs } from './EventTabs';
import { EventPagination } from './EventPagination';
import { EVENTS_PER_PAGE } from '../constants';

interface MapPopupProps {
  location: HistoricalLocation | null;
  onClose: () => void;
}

export function MapPopup({ location, onClose }: MapPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);
  const [activeYear, setActiveYear] = useState<string>('');
  const [currentPage, setCurrentPage] = useState(0);

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
      setActiveYear(years[0] ?? '');
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

  return (
    <div
      ref={popupRef}
      className="w-80 bg-white dark:bg-neutral-800 rounded-xl shadow-xl border border-neutral-200 dark:border-neutral-700 overflow-hidden"
      onMouseEnter={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="px-4 py-3 bg-gradient-to-r from-blue-500 to-purple-500 text-white">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{location.name}</h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-white/20 rounded transition-colors"
            aria-label="Close popup"
          >
            <svg
              className="w-4 h-4"
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
          {location.events.length} event{location.events.length !== 1 ? 's' : ''}
        </p>
      </div>

      {/* Content */}
      <div className="p-4">
        {location.events.length === 0 ? (
          <p className="text-neutral-500 dark:text-neutral-400 text-sm text-center py-4">
            No events at this location yet.
          </p>
        ) : (
          <>
            {/* Year Tabs */}
            <EventTabs
              years={years}
              activeYear={activeYear}
              onYearChange={handleYearChange}
            />

            {/* Event Cards */}
            <div className="space-y-4">
              {paginatedEvents.map((event) => (
                <EventCard key={event.id} event={event} />
              ))}
            </div>

            {/* Pagination */}
            <EventPagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={handlePageChange}
            />
          </>
        )}
      </div>
    </div>
  );
}
