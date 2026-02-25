'use client';

import type { ParsedEvent } from '../../types';
import { formatDate } from '../../utils/date-utils';

interface EventReviewCardProps {
  event: ParsedEvent;
  selected: boolean;
  onToggleSelect: () => void;
  onEdit: () => void;
  onReject: () => void;
}

export function EventReviewCard({
  event,
  selected,
  onToggleSelect,
  onEdit,
  onReject,
}: EventReviewCardProps) {
  const confidenceColor =
    event.confidence >= 0.8
      ? 'text-green-600 dark:text-green-400'
      : event.confidence >= 0.5
        ? 'text-amber-600 dark:text-amber-400'
        : 'text-red-600 dark:text-red-400';

  return (
    <div
      className={`p-4 rounded-lg border transition-colors ${
        selected
          ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
          : 'border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800'
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          className="mt-1 h-5 w-5 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
              {formatDate(event.date)}
            </span>
            <span className={`text-xs ${confidenceColor}`}>
              {Math.round(event.confidence * 100)}% confidence
            </span>
          </div>
          <h4 className="font-medium text-neutral-900 dark:text-neutral-100 mb-1">
            {event.title}
          </h4>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 line-clamp-2">
            {event.description}
          </p>
          {event.sourceText !== event.description && (
            <details className="mt-2">
              <summary className="text-xs text-neutral-500 cursor-pointer hover:text-neutral-700 dark:hover:text-neutral-300">
                Show source text
              </summary>
              <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400 italic bg-neutral-100 dark:bg-neutral-900 p-2 rounded">
                &quot;{event.sourceText}&quot;
              </p>
            </details>
          )}
        </div>
        <div className="flex flex-col gap-1">
          <button
            onClick={onEdit}
            className="px-3 py-1 text-xs font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 border border-blue-300 dark:border-blue-600 rounded hover:bg-blue-50 dark:hover:bg-blue-900/30 transition-colors"
          >
            Edit
          </button>
          <button
            onClick={onReject}
            className="px-3 py-1 text-xs font-medium text-red-600 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300 border border-red-300 dark:border-red-600 rounded hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors"
          >
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}
