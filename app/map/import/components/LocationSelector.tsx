'use client';

import { useState, useEffect } from 'react';
import type { HistoricalLocation } from '../../types';
import { getLocations } from '../../utils/storage';

interface LocationSelectorProps {
  value: string; // location ID or empty for new
  onChange: (locationId: string) => void;
  onCreateNew: (name: string, coords: [number, number]) => void;
  disabled?: boolean;
}

/**
 * Parses a combined coordinate string from Google Maps or similar sources.
 * Accepts formats like "41.6181, -112.5477" or "41.6181 -112.5477"
 */
function parseCoordinates(input: string): { lat: number; lng: number } | null {
  // Match "lat, lng" or "lat lng" format (with optional whitespace)
  const match = input.trim().match(/^(-?\d+\.?\d*)[,\s]+(-?\d+\.?\d*)$/);
  if (!match || !match[1] || !match[2]) return null;

  const lat = parseFloat(match[1]);
  const lng = parseFloat(match[2]);

  if (isNaN(lat) || isNaN(lng)) return null;
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;

  return { lat, lng };
}

export function LocationSelector({ value, onChange, onCreateNew, disabled }: LocationSelectorProps) {
  const [locations, setLocations] = useState<HistoricalLocation[]>([]);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [coordsInput, setCoordsInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocations(getLocations());
  }, []);

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === '__new__') {
      setShowNewForm(true);
      onChange('');
    } else {
      setShowNewForm(false);
      onChange(val);
    }
  };

  const handleCreateLocation = () => {
    setError(null);

    if (!newName.trim()) {
      setError('Please enter a location name');
      return;
    }

    const coords = parseCoordinates(coordsInput);
    if (!coords) {
      setError('Invalid coordinates. Use format: 41.6181, -112.5477');
      return;
    }

    onCreateNew(newName.trim(), [coords.lng, coords.lat]);
    setNewName('');
    setCoordsInput('');
    setShowNewForm(false);
    setError(null);

    // Refresh locations list
    setLocations(getLocations());
  };

  return (
    <div className="space-y-3">
      <label htmlFor="location-select" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
        Target Location
      </label>
      <select
        id="location-select"
        value={showNewForm ? '__new__' : value}
        onChange={handleSelectChange}
        disabled={disabled}
        className="w-full px-4 py-2 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:opacity-50 disabled:cursor-not-allowed"
      >
        <option value="">Select a location...</option>
        {locations.map((loc) => (
          <option key={loc.id} value={loc.id}>
            {loc.name} ({loc.events.length} events)
          </option>
        ))}
        <option value="__new__">+ Create new location</option>
      </select>

      {showNewForm && (
        <div className="p-4 rounded-lg border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-900 space-y-3">
          {error && (
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          )}
          <div>
            <label htmlFor="new-location-name" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              Location Name
            </label>
            <input
              id="new-location-name"
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g., Promontory Summit"
              className="w-full px-3 py-2 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
            />
          </div>
          <div>
            <label htmlFor="new-location-coords" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              Coordinates
            </label>
            <input
              id="new-location-coords"
              type="text"
              value={coordsInput}
              onChange={(e) => setCoordsInput(e.target.value)}
              placeholder="e.g., 41.6181, -112.5477 (paste from Google Maps)"
              className="w-full px-3 py-2 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              Paste coordinates directly from Google Maps
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleCreateLocation}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
            >
              Create Location
            </button>
            <button
              type="button"
              onClick={() => setShowNewForm(false)}
              className="px-4 py-2 bg-neutral-200 hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600 text-neutral-800 dark:text-neutral-200 rounded-lg text-sm font-medium transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
