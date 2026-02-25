'use client';

import type { ParsedEvent } from '../../types';
import { EventReviewCard } from './EventReviewCard';

interface EventReviewListProps {
  events: ParsedEvent[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onEdit: (event: ParsedEvent) => void;
  onReject: (id: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
}

export function EventReviewList({
  events,
  selectedIds,
  onToggleSelect,
  onEdit,
  onReject,
  onSelectAll,
  onDeselectAll,
}: EventReviewListProps) {
  if (events.length === 0) {
    return (
      <div className="text-center py-8 text-neutral-500 dark:text-neutral-400">
        No events extracted yet. Paste a document and click &quot;Parse Document&quot; to get started.
      </div>
    );
  }

  const selectedCount = selectedIds.size;
  const allSelected = selectedCount === events.length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium text-neutral-900 dark:text-neutral-100">
          Extracted Events ({events.length} found)
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-sm text-neutral-500 dark:text-neutral-400">
            {selectedCount} selected
          </span>
          <button
            onClick={allSelected ? onDeselectAll : onSelectAll}
            className="text-sm text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300"
          >
            {allSelected ? 'Deselect all' : 'Select all'}
          </button>
        </div>
      </div>

      <div className="space-y-3 max-h-96 overflow-y-auto">
        {events.map((event) => (
          <EventReviewCard
            key={event.id}
            event={event}
            selected={selectedIds.has(event.id)}
            onToggleSelect={() => onToggleSelect(event.id)}
            onEdit={() => onEdit(event)}
            onReject={() => onReject(event.id)}
          />
        ))}
      </div>
    </div>
  );
}
