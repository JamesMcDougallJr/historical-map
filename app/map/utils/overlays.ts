import type { HistoricalOverlay } from '../types';

/**
 * Default historical overlays curated for Western US history exploration.
 * These overlays provide context for events from 1850-1920.
 */
export const DEFAULT_OVERLAYS: HistoricalOverlay[] = [
  {
    id: 'ohm-historical',
    name: 'OpenHistoricalMap',
    description: 'Community-mapped historical roads, railroads, and boundaries',
    yearRange: [1850, 1920],
    source: 'ohm',
    tileUrl: 'https://vtiles.openhistoricalmap.org/maps/osm/{z}/{x}/{y}.pbf',
    opacity: 0.7,
    attribution: '© OpenHistoricalMap contributors',
    enabled: false,
    zIndex: 1,
  },
  {
    id: 'usgs-topo-historical',
    name: 'USGS Historical Topos',
    description: 'US Geological Survey topographic maps from 1884-2006',
    yearRange: [1884, 2006],
    source: 'usgs',
    tileUrl: 'https://basemap.nationalmap.gov/arcgis/services/USGSImageryTopo/MapServer/WMSServer',
    opacity: 0.6,
    attribution: 'USGS The National Map',
    enabled: false,
    zIndex: 2,
  },
  {
    id: 'manchester-1820',
    name: 'Manchester & Salford 1820',
    description: 'Historical plan of Manchester and Salford, England - demo overlay',
    yearRange: [1820, 1850],
    source: 'allmaps',
    annotationUrl: 'https://annotations.allmaps.org/maps/0984d3d4501b1b9a',
    opacity: 0.7,
    attribution: 'Georeferenced with Allmaps',
    enabled: false,
    zIndex: 3,
  },
];

/**
 * Creates a unique ID for a new overlay
 */
export function generateOverlayId(): string {
  return `overlay-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Filters overlays that match a given year
 */
export function filterOverlaysByYear(
  overlays: HistoricalOverlay[],
  year: number
): HistoricalOverlay[] {
  return overlays.filter(
    (overlay) => year >= overlay.yearRange[0] && year <= overlay.yearRange[1]
  );
}

/**
 * Sorts overlays by zIndex for proper layer ordering
 */
export function sortOverlaysByZIndex(
  overlays: HistoricalOverlay[]
): HistoricalOverlay[] {
  return [...overlays].sort((a, b) => (a.zIndex ?? 0) - (b.zIndex ?? 0));
}

/**
 * Validates an Allmaps annotation URL
 */
export function isValidAllmapsUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes('allmaps.org') ||
      parsed.hostname.includes('iiif.io') ||
      parsed.protocol === 'https:'
    );
  } catch {
    return false;
  }
}

/**
 * Gets the appropriate attribution string for an overlay source
 */
export function getSourceAttribution(source: HistoricalOverlay['source']): string {
  switch (source) {
    case 'allmaps':
      return 'Map georeferenced with Allmaps';
    case 'ohm':
      return '© OpenHistoricalMap contributors';
    case 'usgs':
      return 'USGS The National Map';
    case 'nypl':
      return 'NYPL Map Warper';
    case 'custom':
      return '';
    default:
      return '';
  }
}
