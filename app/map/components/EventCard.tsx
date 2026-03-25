"use client";

import type { HistoricalEvent } from "../types";
import { formatDate } from "../utils/date-utils";
import { ExpandableText } from "../../components/expandable-text";

interface EventCardProps {
  event: HistoricalEvent;
  isAcknowledged?: boolean;
  onAcknowledge?: (eventId: string) => void;
}

export function EventCard({
  event,
  isAcknowledged,
  onAcknowledge,
}: EventCardProps) {
  return (
    <div
      className={`space-y-2 rounded-lg p-2 -mx-2 transition-colors ${isAcknowledged ? "bg-green-50 dark:bg-green-950/30" : ""}`}
    >
      <div className="flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
              {formatDate(event.date)}
            </span>
            {isAcknowledged && (
              <span className="text-xs text-green-600 dark:text-green-400 font-medium">
                +10 pts
              </span>
            )}
            {event.tags && event.tags.length > 0 && (
              <div className="flex gap-1">
                {event.tags.slice(0, 2).map((tag) => (
                  <span
                    key={tag}
                    className="px-2 py-0.5 text-xs bg-neutral-100 dark:bg-neutral-700 text-neutral-600 dark:text-neutral-300 rounded"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            )}
          </div>
          <ExpandableText
            text={event.title}
            maxLines={1}
            className="font-medium text-neutral-900 dark:text-neutral-100"
          />
          <ExpandableText
            text={event.description}
            maxLines={3}
            className="text-sm text-neutral-600 dark:text-neutral-400 leading-relaxed"
          />
        </div>
        {onAcknowledge && (
          <button
            onClick={() => onAcknowledge(event.id)}
            disabled={isAcknowledged}
            className={`flex-shrink-0 mt-1 w-8 h-8 rounded-full flex items-center justify-center transition-all ${
              isAcknowledged
                ? "bg-green-500 text-white cursor-default"
                : "bg-neutral-100 dark:bg-neutral-700 text-neutral-400 dark:text-neutral-500 hover:bg-green-100 hover:text-green-600 dark:hover:bg-green-900/50 dark:hover:text-green-400"
            }`}
            aria-label={
              isAcknowledged ? "Event acknowledged" : "Acknowledge event"
            }
          >
            <svg
              className="w-4 h-4"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              strokeWidth={2.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M5 13l4 4L19 7"
              />
            </svg>
          </button>
        )}
      </div>
      {event.imageUrl && (
        <img
          src={event.imageUrl}
          alt={event.title}
          loading="lazy"
          className="w-full h-32 object-cover rounded mt-2"
        />
      )}
      {event.source && (
        <div className="mt-2">
          <ExpandableText
            text={`Source: ${event.source}`}
            maxLines={1}
            className="text-xs text-neutral-500 dark:text-neutral-500 italic"
          />
        </div>
      )}
    </div>
  );
}
