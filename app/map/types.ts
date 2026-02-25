// Historical Events Types

export interface HistoricalEvent {
  id: string;
  title: string;
  description: string;
  date: string; // ISO 8601: "1869-05-10"
  imageUrl?: string;
  tags?: string[];
  source?: string;
}

export interface HistoricalLocation {
  id: string;
  name: string;
  coordinates: [number, number]; // [longitude, latitude]
  events: HistoricalEvent[];
}

export interface HistoricalEventsData {
  version: string;
  lastUpdated: string;
  locations: HistoricalLocation[];
}

// Parser Types

export interface ParsedEvent {
  id: string;
  title: string;
  description: string;
  date: string;
  confidence: number; // 0-1, for AI parsing quality
  sourceText: string; // Original text snippet
}

export interface ProcessingJob {
  id: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  progress: number; // 0-100
  totalChunks: number;
  completedChunks: number;
  results: ParsedEvent[];
  errors: string[];
}

export interface EventProcessingService {
  // Synchronous for small documents (<50KB)
  parseSync(text: string, strategy: string): ParsedEvent[];

  // Async job-based for large documents (future)
  createJob?(text: string, strategy: string): Promise<string>;
  getJobStatus?(jobId: string): Promise<ProcessingJob>;
  cancelJob?(jobId: string): Promise<void>;
}

// Parser strategy type
export type ParserStrategy = 'regex' | 'structured';

// Historical Map Overlay Types

export type OverlaySource = 'allmaps' | 'ohm' | 'usgs' | 'nypl' | 'custom';

export interface HistoricalOverlay {
  id: string;
  name: string;
  description?: string;
  yearRange: [number, number]; // e.g., [1860, 1880]
  source: OverlaySource;
  tileUrl?: string; // For XYZ/WMS sources
  annotationUrl?: string; // For Allmaps IIIF georeferenced maps
  opacity: number; // 0-1
  attribution?: string;
  enabled: boolean;
  zIndex?: number; // Layer ordering
}
