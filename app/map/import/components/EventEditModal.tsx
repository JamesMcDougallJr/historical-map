'use client';

import { useState, useEffect } from 'react';
import type { ParsedEvent } from '../../types';

interface EventEditModalProps {
  event: ParsedEvent | null;
  onSave: (event: ParsedEvent) => void;
  onClose: () => void;
}

export function EventEditModal({ event, onSave, onClose }: EventEditModalProps) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (event) {
      setTitle(event.title);
      setDate(event.date);
      setDescription(event.description);
      setError(null);
    }
  }, [event]);

  if (!event) return null;

  const handleSave = () => {
    setError(null);

    if (!title.trim() || !date.trim()) {
      setError('Title and date are required');
      return;
    }

    onSave({
      ...event,
      title: title.trim(),
      date: date.trim(),
      description: description.trim(),
    });
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div className="relative w-full max-w-lg mx-4 bg-white dark:bg-neutral-800 rounded-xl shadow-xl">
        <div className="p-6">
          <h2
            id="edit-modal-title"
            className="text-xl font-semibold text-neutral-900 dark:text-neutral-100 mb-4"
          >
            Edit Event
          </h2>

          <div className="space-y-4">
            {error && (
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            )}

            <div>
              <label htmlFor="edit-title" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Title
              </label>
              <input
                id="edit-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label htmlFor="edit-date" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Date (ISO format: YYYY-MM-DD)
              </label>
              <input
                id="edit-date"
                type="text"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                placeholder="1869-05-10"
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>

            <div>
              <label htmlFor="edit-description" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Description
              </label>
              <textarea
                id="edit-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                className="w-full px-3 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-y"
              />
            </div>
          </div>

          <div className="flex justify-end gap-3 mt-6">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-700 hover:bg-neutral-200 dark:hover:bg-neutral-600 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
