// localStorage read/write utilities for historical events

import type { HistoricalEventsData, HistoricalLocation, HistoricalEvent } from '../types';

const STORAGE_KEY = 'historical-events';

// Default data structure
const DEFAULT_DATA: HistoricalEventsData = {
  version: '1.0.0',
  lastUpdated: new Date().toISOString(),
  locations: [],
};

/**
 * Get all historical events data from localStorage
 */
export function getEventsData(): HistoricalEventsData {
  if (typeof window === 'undefined') return DEFAULT_DATA;

  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_DATA;

    const data = JSON.parse(stored) as HistoricalEventsData;
    return data;
  } catch {
    console.error('Failed to parse historical events from localStorage');
    return DEFAULT_DATA;
  }
}

/**
 * Save all historical events data to localStorage
 */
export function saveEventsData(data: HistoricalEventsData): void {
  if (typeof window === 'undefined') return;

  try {
    const toSave: HistoricalEventsData = {
      ...data,
      lastUpdated: new Date().toISOString(),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
  } catch (error) {
    console.error('Failed to save historical events to localStorage:', error);
  }
}

/**
 * Get all locations
 */
export function getLocations(): HistoricalLocation[] {
  return getEventsData().locations;
}

/**
 * Get a single location by ID
 */
export function getLocation(locationId: string): HistoricalLocation | undefined {
  return getLocations().find(loc => loc.id === locationId);
}

/**
 * Add or update a location
 */
export function saveLocation(location: HistoricalLocation): void {
  const data = getEventsData();
  const existingIndex = data.locations.findIndex(loc => loc.id === location.id);

  if (existingIndex >= 0) {
    data.locations[existingIndex] = location;
  } else {
    data.locations.push(location);
  }

  saveEventsData(data);
}

/**
 * Delete a location
 */
export function deleteLocation(locationId: string): void {
  const data = getEventsData();
  data.locations = data.locations.filter(loc => loc.id !== locationId);
  saveEventsData(data);
}

/**
 * Add events to a location
 */
export function addEventsToLocation(locationId: string, events: HistoricalEvent[]): void {
  const data = getEventsData();
  const location = data.locations.find(loc => loc.id === locationId);

  if (location) {
    // Merge events, avoiding duplicates by ID
    const existingIds = new Set(location.events.map(e => e.id));
    const newEvents = events.filter(e => !existingIds.has(e.id));
    location.events = [...location.events, ...newEvents];
    saveEventsData(data);
  }
}

/**
 * Update a single event
 */
export function updateEvent(locationId: string, event: HistoricalEvent): void {
  const data = getEventsData();
  const location = data.locations.find(loc => loc.id === locationId);

  if (location) {
    const eventIndex = location.events.findIndex(e => e.id === event.id);
    if (eventIndex >= 0) {
      location.events[eventIndex] = event;
      saveEventsData(data);
    }
  }
}

/**
 * Delete an event from a location
 */
export function deleteEvent(locationId: string, eventId: string): void {
  const data = getEventsData();
  const location = data.locations.find(loc => loc.id === locationId);

  if (location) {
    location.events = location.events.filter(e => e.id !== eventId);
    saveEventsData(data);
  }
}

/**
 * Create a new location with events
 */
export function createLocationWithEvents(
  name: string,
  coordinates: [number, number],
  events: HistoricalEvent[]
): HistoricalLocation {
  const id = generateLocationId(name);
  const location: HistoricalLocation = {
    id,
    name,
    coordinates,
    events,
  };
  saveLocation(location);
  return location;
}

/**
 * Generate a URL-safe ID from a name with collision avoidance
 */
export function generateLocationId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const suffix = Date.now().toString(36).slice(-4);
  return `${base}-${suffix}`;
}

/**
 * Generate a unique event ID
 */
export function generateEventId(): string {
  return `event-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Export data as JSON string (for download)
 */
export function exportToJSON(): string {
  return JSON.stringify(getEventsData(), null, 2);
}

/**
 * Import data from JSON string
 */
export function importFromJSON(json: string): boolean {
  try {
    const data = JSON.parse(json) as HistoricalEventsData;
    if (!data.version || !Array.isArray(data.locations)) {
      throw new Error('Invalid data format');
    }
    saveEventsData(data);
    return true;
  } catch (error) {
    console.error('Failed to import JSON:', error);
    return false;
  }
}

/**
 * Clear all stored data
 */
export function clearAllData(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(STORAGE_KEY);
}
