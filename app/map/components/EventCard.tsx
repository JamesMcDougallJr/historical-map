'use client';

import type { HistoricalEvent } from '../types';
import { formatDate } from '../utils/date-utils';
import { ExpandableText } from '../../components/expandable-text';

interface EventCardProps {
  event: HistoricalEvent;
}

export function EventCard({ event }: EventCardProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
          {formatDate(event.date)}
        </span>
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
