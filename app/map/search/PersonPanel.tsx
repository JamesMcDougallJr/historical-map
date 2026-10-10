"use client";

// What clicking a person opens beside the filtered map: the events naming
// them, in date order (plans/22-search-people.md, Level 2). The same shape as
// the sequence panel, with the order coming from `date` instead of `seq`.

import type { HistoricalEvent, HistoricalLocation } from "../types";
import { formatDate } from "../utils/date-utils";
import { SearchPanel } from "./SearchPanel";
import type { SearchLayout } from "./SearchBox";

export function PersonPanel({
  layout,
  title,
  events,
  onShowEvent,
  onClose,
}: {
  layout: SearchLayout;
  title: string;
  /** Already in date order. */
  events: Array<{
    event: HistoricalEvent;
    location: HistoricalLocation;
  }> | null;
  onShowEvent(event: HistoricalEvent, location: HistoricalLocation): void;
  onClose(): void;
}): JSX.Element {
  return (
    <SearchPanel
      layout={layout}
      title={title}
      onClose={onClose}
      testId="person-panel"
    >
      <p className="px-4 pt-3 text-xs text-slate-500">
        Events naming “{title}”. Other spellings of the same person appear as
        separate results until people are resolved to identities.
      </p>
      <ol className="px-4 py-3 space-y-1">
        {(events ?? []).map(({ event, location }) => (
          <li key={event.id}>
            <button
              type="button"
              className="search-touch-target flex w-full items-baseline gap-3 rounded-md px-2 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
              data-testid="person-panel-event"
              data-event-id={event.id}
              onClick={() => onShowEvent(event, location)}
            >
              <span className="w-20 shrink-0 text-xs font-medium text-slate-600">
                {formatDate(event.date, event.datePrecision, event.dateText)}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                  {event.title}
                </span>
                <span className="block text-xs text-slate-500">
                  {location.name}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </SearchPanel>
  );
}
