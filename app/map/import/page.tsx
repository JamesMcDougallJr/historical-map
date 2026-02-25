'use client';

import { useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import type { ParsedEvent, ParserStrategy, HistoricalEvent } from '../types';
import { DocumentInput } from './components/DocumentInput';
import { ParserSelector } from './components/ParserSelector';
import { LocationSelector } from './components/LocationSelector';
import { EventReviewList } from './components/EventReviewList';
import { EventEditModal } from './components/EventEditModal';
import {
  createLocationWithEvents,
  addEventsToLocation,
  getLocation,
  generateEventId,
} from '../utils/storage';

export default function ImportPage() {
  const router = useRouter();

  // Form state
  const [documentText, setDocumentText] = useState('');
  const [parserStrategy, setParserStrategy] = useState<ParserStrategy>('regex');
  const [locationId, setLocationId] = useState('');

  // Parsing state
  const [isParsing, setIsParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsedEvents, setParsedEvents] = useState<ParsedEvent[]>([]);
  const [selectedEventIds, setSelectedEventIds] = useState<Set<string>>(new Set());

  // Edit modal state
  const [editingEvent, setEditingEvent] = useState<ParsedEvent | null>(null);

  // Handle location creation
  const handleCreateLocation = (name: string, coords: [number, number]) => {
    const location = createLocationWithEvents(name, coords, []);
    setLocationId(location.id);
  };

  // Parse the document
  const handleParse = useCallback(async () => {
    if (!documentText.trim()) {
      setParseError('Please enter some document text');
      return;
    }

    setIsParsing(true);
    setParseError(null);
    setParsedEvents([]);
    setSelectedEventIds(new Set());

    try {
      const response = await fetch('/api/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: documentText,
          strategy: parserStrategy,
        }),
      });

      const data = (await response.json()) as {
        success: boolean;
        events: ParsedEvent[];
        error?: string;
      };

      if (!data.success) {
        setParseError(data.error ?? 'Failed to parse document');
        return;
      }

      setParsedEvents(data.events);
      // Select all events by default
      setSelectedEventIds(new Set(data.events.map((e) => e.id)));
    } catch (error) {
      setParseError(error instanceof Error ? error.message : 'Network error');
    } finally {
      setIsParsing(false);
    }
  }, [documentText, parserStrategy]);

  // Toggle event selection
  const handleToggleSelect = (id: string) => {
    setSelectedEventIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  // Select/deselect all
  const handleSelectAll = () => {
    setSelectedEventIds(new Set(parsedEvents.map((e) => e.id)));
  };

  const handleDeselectAll = () => {
    setSelectedEventIds(new Set());
  };

  // Reject an event (remove from list)
  const handleReject = (id: string) => {
    setParsedEvents((prev) => prev.filter((e) => e.id !== id));
    setSelectedEventIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  };

  // Save edited event
  const handleSaveEdit = (updatedEvent: ParsedEvent) => {
    setParsedEvents((prev) =>
      prev.map((e) => (e.id === updatedEvent.id ? updatedEvent : e))
    );
  };

  // Add selected events to map
  const handleAddToMap = () => {
    if (!locationId) {
      setParseError('Please select or create a target location');
      return;
    }

    const location = getLocation(locationId);
    if (!location) {
      setParseError('Selected location not found');
      return;
    }

    // Convert ParsedEvents to HistoricalEvents
    const selectedEvents = parsedEvents.filter((e) => selectedEventIds.has(e.id));
    const historicalEvents: HistoricalEvent[] = selectedEvents.map((e) => ({
      id: generateEventId(),
      title: e.title,
      description: e.description,
      date: e.date,
      source: e.sourceText,
    }));

    addEventsToLocation(locationId, historicalEvents);

    // Navigate to map with refresh key to trigger data reload
    router.push(`/map?t=${Date.now()}`);
  };

  return (
    <div className="max-w-3xl mx-auto">
      <section className="mb-8">
        <h1 className="font-semibold text-2xl mb-2 tracking-tighter bg-gradient-to-r from-blue-500 to-purple-500 bg-clip-text text-transparent">
          Import Historical Events
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400">
          Paste document text to extract historical events with dates.
        </p>
      </section>

      <div className="space-y-6">
        {/* Document Input */}
        <DocumentInput
          value={documentText}
          onChange={setDocumentText}
          disabled={isParsing}
        />

        {/* Parser and Location Selection */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <ParserSelector
            value={parserStrategy}
            onChange={setParserStrategy}
            disabled={isParsing}
          />
          <LocationSelector
            value={locationId}
            onChange={setLocationId}
            onCreateNew={handleCreateLocation}
            disabled={isParsing}
          />
        </div>

        {/* Parse Button */}
        <button
          onClick={handleParse}
          disabled={isParsing || !documentText.trim()}
          className="w-full py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
        >
          {isParsing ? 'Parsing...' : 'Parse Document'}
        </button>

        {/* Error Display */}
        {parseError && (
          <div className="p-4 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-400">
            {parseError}
          </div>
        )}

        {/* Results */}
        {parsedEvents.length > 0 && (
          <>
            <hr className="border-neutral-200 dark:border-neutral-700" />

            <EventReviewList
              events={parsedEvents}
              selectedIds={selectedEventIds}
              onToggleSelect={handleToggleSelect}
              onEdit={setEditingEvent}
              onReject={handleReject}
              onSelectAll={handleSelectAll}
              onDeselectAll={handleDeselectAll}
            />

            {/* Add to Map Button */}
            <button
              onClick={handleAddToMap}
              disabled={selectedEventIds.size === 0 || !locationId}
              className="w-full py-3 bg-green-600 hover:bg-green-700 disabled:bg-green-400 disabled:cursor-not-allowed text-white rounded-lg font-medium transition-colors"
            >
              Add {selectedEventIds.size} Selected Event
              {selectedEventIds.size !== 1 ? 's' : ''} to Map
            </button>
          </>
        )}
      </div>

      {/* Edit Modal */}
      <EventEditModal
        event={editingEvent}
        onSave={handleSaveEdit}
        onClose={() => setEditingEvent(null)}
      />
    </div>
  );
}
