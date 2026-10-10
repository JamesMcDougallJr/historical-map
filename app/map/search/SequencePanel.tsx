"use client";

// What clicking a sequence opens beside the filtered map: its members in
// narrative (seq) order. Clicking a member runs the event action.

import { useEffect, useState } from "react";
import type { EventGroup, HistoricalEvent, HistoricalLocation } from "../types";
import { formatDate } from "../utils/date-utils";
import { fetchGroup } from "./search-client";
import { SearchPanel } from "./SearchPanel";
import type { SearchLayout } from "./SearchBox";

export function SequencePanel({
  layout,
  groupId,
  title,
  onShowMember,
  onClose,
}: {
  layout: SearchLayout;
  groupId: string;
  title: string;
  onShowMember(event: HistoricalEvent, location: HistoricalLocation): void;
  onClose(): void;
}): JSX.Element {
  const [data, setData] = useState<{
    group: EventGroup;
    members: HistoricalLocation[];
  } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    fetchGroup(groupId, controller.signal)
      .then(setData)
      .catch(() => {});
    return () => controller.abort();
  }, [groupId]);

  // Members come back grouped by location; memberEventIds is the order.
  const ordered: Array<{
    event: HistoricalEvent;
    location: HistoricalLocation;
  }> = [];
  if (data) {
    const byEvent = new Map<
      string,
      { event: HistoricalEvent; location: HistoricalLocation }
    >();
    for (const location of data.members) {
      for (const event of location.events)
        byEvent.set(event.id, { event, location });
    }
    for (const id of data.group.memberEventIds) {
      const pair = byEvent.get(id);
      if (pair) ordered.push(pair);
    }
  }

  return (
    <SearchPanel
      layout={layout}
      title={data?.group.title ?? title}
      onClose={onClose}
      testId="sequence-panel"
    >
      {data?.group.description && (
        <p className="px-4 pt-3 text-sm text-slate-600 dark:text-slate-300">
          {data.group.description}
        </p>
      )}
      <ol className="px-4 py-3 space-y-1">
        {ordered.map(({ event, location }, i) => (
          <li key={event.id}>
            <button
              type="button"
              className="search-touch-target flex w-full items-baseline gap-3 rounded-md px-2 py-2 text-left hover:bg-slate-50 dark:hover:bg-slate-800"
              data-testid="sequence-panel-member"
              data-event-id={event.id}
              onClick={() => onShowMember(event, location)}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-white">
                {i + 1}
              </span>
              <span className="flex-1">
                <span className="block text-sm font-medium text-slate-900 dark:text-slate-100">
                  {event.title}
                </span>
                <span className="block text-xs text-slate-500">
                  {formatDate(event.date, event.datePrecision, event.dateText)}{" "}
                  · {location.name}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>
    </SearchPanel>
  );
}
