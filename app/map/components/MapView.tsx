"use client";

import { createMapClient } from "@historical-map/api-client";
import { Feature, Map as OlMap, View, Overlay } from "ol";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import TileLayer from "ol/layer/Tile";
import TileWMS from "ol/source/TileWMS";
import VectorTileLayer from "ol/layer/VectorTile";
import VectorTileSource from "ol/source/VectorTile";
import MVT from "ol/format/MVT";
import { defaults as defaultControls } from "ol/control/defaults";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { fromLonLat, toLonLat, transformExtent } from "ol/proj";
import { boundingExtent } from "ol/extent";
import Point from "ol/geom/Point";
import LineString from "ol/geom/LineString";
import Style, { type StyleFunction } from "ol/style/Style";
import Icon from "ol/style/Icon";
import CircleStyle from "ol/style/Circle";
import Fill from "ol/style/Fill";
import Stroke from "ol/style/Stroke";
import Text from "ol/style/Text";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import type {
  EventGroup,
  EventLayer,
  HistoricalEvent,
  HistoricalLocation,
  HistoricalOverlay,
} from "../types";
import { DEFAULT_OVERLAYS } from "../utils/overlays";
import { getEventLayers, mvtQueryString } from "../utils/event-layers";
import {
  GROUP_CONNECTIVE_THRESHOLD_KM,
  maxPairwiseDistanceKm,
} from "../utils/event-groups";
import {
  choosePopupPlacement,
  verticalSpace,
  POPUP_PIN_GAP,
  POPUP_MIN_BODY_HEIGHT,
} from "../utils/popup-placement";
import { MapPopup } from "./MapPopup";
import { ScoreBadge } from "./ScoreBadge";
import { LayerControl } from "./LayerControl";
import { TimelineSlider } from "./TimelineSlider";
import {
  getProgress,
  acknowledgeEvent as ackEvent,
  type MapProgress,
} from "../utils/storage";
import { eventInYearRange, eventYearSpan } from "@historical-map/domain";
import type BaseLayer from "ol/layer/Base";
import type { FeatureLike } from "ol/Feature";
// Positions OL's controls, overlays and attribution. Imported here rather than
// in a layout so both consumers get it — the Next app and the MCP App bundle.
import "ol/ol.css";

// Same-origin (no auth check on this route today — see loadLocationDetail).
const mapClient = createMapClient();

// Pin icon SVG as data URL for historical events (module scope - created once)
const EVENT_PIN_SVG = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
  <path fill="#3b82f6" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
</svg>
`)}`;

// Reusable pin style (module scope)
const PIN_STYLE = new Style({
  image: new Icon({ anchor: [0.5, 1], src: EVENT_PIN_SVG, scale: 1 }),
});

// Home marker and layer (module scope - created once)
const homeMarker = new Feature({
  geometry: new Point(fromLonLat([-111.8864, 40.7444])),
});
homeMarker.setStyle(
  new Style({
    image: new Icon({
      anchor: [0.5, 1],
      src: "https://cdn-icons-png.flaticon.com/512/684/684908.png",
      scale: 0.07,
    }),
  }),
);
const homeVectorLayer = new VectorLayer({
  source: new VectorSource({ features: [homeMarker] }),
});
homeVectorLayer.set("layerId", "home");

function createOHMStyle() {
  return new Style({
    fill: new Fill({ color: "rgba(139, 92, 246, 0.1)" }),
    stroke: new Stroke({ color: "rgba(139, 92, 246, 0.7)", width: 1.5 }),
  });
}

/**
 * useLayoutEffect, minus the server warning.
 *
 * Placement has to run before paint or the popup shows for a frame in the wrong
 * spot, but MapView is server-rendered for the initial HTML and React warns that
 * useLayoutEffect does nothing there.
 */
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** Lon/lat of a pin, whichever feature flavour the layer produced. */
function featureLonLat(feature: FeatureLike): [number, number] | null {
  const geometry = feature.getGeometry();
  if (!geometry) return null;

  // MVT tiles yield RenderFeature, which has no getCoordinates() — its
  // coordinates come out flat. Plain Feature (geojson/inline) has the geometry.
  const flat =
    "getCoordinates" in geometry
      ? (geometry as Point).getCoordinates()
      : (
          geometry as unknown as { getFlatCoordinates(): number[] }
        ).getFlatCoordinates();

  if (!flat || flat.length < 2) return null;
  const [lon, lat] = toLonLat([flat[0]!, flat[1]!]);
  return [lon!, lat!];
}

/**
 * The location a pin refers to, as far as can be told from the feature alone.
 *
 * Returns a stub carrying id, name and position but no events — MVT properties
 * are flat scalars, so events never ride along in the tile. Callers fill events
 * in from `byId` (already-loaded locations, which is all the MCP App has) or by
 * fetching detail; see loadLocationDetail.
 */
function resolveLocation(
  feature: FeatureLike,
  byId: Map<string, HistoricalLocation>,
): HistoricalLocation | null {
  const id = feature.get("location_id") as string | undefined;
  if (!id) return null;

  // GeoJSON pins carry their events inline (see the /api/sources route), so the
  // popup is complete immediately. MVT pins can't, and come back with none —
  // those get filled in by loadLocationDetail.
  //
  // Checked before `byId`, which is seeded from localStorage and can be stale:
  // the feature came from the same request that drew the pin, so when it has
  // events they are the ones that belong to it.
  let events: HistoricalEvent[] = [];
  const encoded = feature.get("events") as string | undefined;
  if (encoded) {
    try {
      events = JSON.parse(encoded) as HistoricalEvent[];
    } catch {
      events = [];
    }
  }

  const known = byId.get(id);
  if (events.length === 0 && known) return known;

  const coords = featureLonLat(feature);
  if (!coords) return known ?? null;

  return {
    id,
    name: (feature.get("name") as string) ?? id,
    coordinates: coords,
    events,
  };
}

/** Pin style in a layer's own colour, so sources are distinguishable. */
function pinStyleFor(color: string | undefined): Style {
  if (!color) return PIN_STYLE;
  const svg = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
  <path fill="${color}" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
</svg>
`)}`;
  return new Style({
    image: new Icon({ anchor: [0.5, 1], src: svg, scale: 1 }),
  });
}

/**
 * Everything the shared pin style function reads, held in a ref.
 *
 * OL creates a layer's style function once, so — like `isPinnedRef` — anything
 * it depends on has to be read through a ref or it closes over stale values.
 * Changing any of this calls `layer.changed()`, which re-styles the features
 * already drawn **without refetching**: on the MVT path, `source.setUrl` would
 * refetch every tile, which is why highlighting must never go through it.
 */
interface PinStyleState {
  /** Pins carry `min_year`/`max_year`, the precision-aware span of their events. */
  timeline: { enabled: boolean; range: [number, number] };
  /** Search highlight: matching location ids, or null when no search is active. */
  highlight: ReadonlySet<string> | null;
  /** False when the id list is capped: highlight those, but dim nothing. */
  dimOthers: boolean;
  /** The single location whose result row is focused in the search list. */
  pulse: string | null;
  /** A "Showing: …" filter (a document's events): only these locations draw. */
  focus: ReadonlySet<string> | null;
}

interface PinStyleSet {
  normal: Style;
  /** Source colour with a halo and a scale bump. */
  highlight: Style[];
  /** Same colour at low opacity, so layer colours still read correctly. */
  dim: Style;
  pulse: Style[];
}

const pinStyleSets = new Map<string, PinStyleSet>();

function pinIconSrc(color: string): string {
  return `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
  <path fill="${color}" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
</svg>
`)}`;
}

function pinStyleSet(color = "#3b82f6"): PinStyleSet {
  const cached = pinStyleSets.get(color);
  if (cached) return cached;
  const src = pinIconSrc(color);
  // The halo sits on the pin's head: the icon is anchored at its tip, so the
  // circle is displaced upward by roughly the head's height.
  const halo = (radius: number) =>
    new Style({
      image: new CircleStyle({
        radius,
        displacement: [0, 22],
        fill: new Fill({ color: "rgba(250, 204, 21, 0.45)" }),
        stroke: new Stroke({ color: "#ffffff", width: 2 }),
      }),
    });
  const icon = (scale: number, opacity = 1) =>
    new Style({ image: new Icon({ anchor: [0.5, 1], src, scale, opacity }) });
  const set: PinStyleSet = {
    normal: icon(1),
    highlight: [halo(14), icon(1.25)],
    dim: icon(1, 0.25),
    pulse: [halo(18), icon(1.5)],
  };
  pinStyleSets.set(color, set);
  return set;
}

function makePinStyleFunction(
  color: string | undefined,
  state: { current: PinStyleState },
): StyleFunction {
  return (feature) => {
    const s = state.current;
    const id = feature.get("location_id") as string | undefined;
    // Highlighting composes with the timeline: a pin the timeline hides stays
    // hidden, whatever matches.
    if (s.timeline.enabled) {
      const min = (feature.get("min_year") as number | undefined) ?? -Infinity;
      const max = (feature.get("max_year") as number | undefined) ?? Infinity;
      if (max < s.timeline.range[0] || min > s.timeline.range[1]) return;
    }
    if (s.focus && !(id && s.focus.has(id))) return;
    const styles = pinStyleSet(color);
    if (s.pulse && id === s.pulse) return styles.pulse;
    if (!s.highlight) return styles.normal;
    if (id && s.highlight.has(id)) return styles.highlight;
    return s.dimOthers ? styles.dim : styles.normal;
  };
}

/** The precision-aware year span of a location's events, for `min_year`/`max_year`. */
function eventsYearSpan(events: HistoricalEvent[]): [number, number] {
  const spans = events.map((e) => eventYearSpan(e.date, e.datePrecision));
  if (spans.length === 0) return [0, 0];
  return [
    Math.min(...spans.map((sp) => sp[0])),
    Math.max(...spans.map((sp) => sp[1])),
  ];
}

/**
 * Builds an OpenLayers layer for an event source, switching on how it's served
 * — directly parallel to createOverlayLayer below.
 *
 * Both kinds emit the same feature properties (location_id, source_id, name,
 * min_year, max_year, event_count), so everything downstream is kind-agnostic.
 */
function buildEventLayer(
  layer: EventLayer,
  locations: HistoricalLocation[],
  styleState: { current: PinStyleState },
): BaseLayer {
  const style = makePinStyleFunction(layer.color, styleState);

  if (layer.kind === "inline") {
    const features = locations.map((location) => {
      const [minYear, maxYear] = eventsYearSpan(location.events);
      return new Feature({
        geometry: new Point(fromLonLat(location.coordinates)),
        // Same property names the other two kinds emit, so hover, click and
        // the timeline treat all three identically.
        location_id: location.id,
        source_id: layer.id,
        name: location.name,
        min_year: minYear,
        max_year: maxYear,
        event_count: location.events.length,
      });
    });
    const inlineLayer = new VectorLayer({
      source: new VectorSource({ features }),
      style,
    });
    inlineLayer.set("eventLayerId", layer.id);
    inlineLayer.set("layerId", "events");
    return inlineLayer;
  }

  const olLayer =
    layer.kind === "mvt"
      ? new VectorTileLayer({
          source: new VectorTileSource({
            format: new MVT(),
            url: `${layer.url}${mvtQueryString({ sourceIds: layer.sourceIds })}`,
            attributions: layer.attribution,
          }),
          style,
        })
      : new VectorLayer({
          source: new VectorSource({
            url: layer.url,
            format: new GeoJSON({ featureProjection: "EPSG:3857" }),
            attributions: layer.attribution,
          }),
          style,
        });

  olLayer.set("eventLayerId", layer.id);
  olLayer.set("layerId", "events");
  return olLayer;
}

export interface MapViewProps {
  locations: HistoricalLocation[];
  initialOverlays?: HistoricalOverlay[];
  /**
   * Event layers to render. Defaults to the registry in utils/event-layers.
   * The MCP App passes an `inline` layer, since it has no origin to fetch from.
   */
  initialEventLayers?: EventLayer[];
  /** Named sequences (EventGroup) available to drill into. Defaults to []. */
  eventGroups?: EventGroup[];
  /** Show navigation controls (Home link, Import Events link). Defaults true. */
  showNav?: boolean;
  homeHref?: string;
  importHref?: string;
  onRefresh?: () => void;

  // ── Timeline, optionally controlled ───────────────────────────────────────
  // /map lifts the timeline into the page shell, because search follows it.
  // Absent, MapView keeps its own state — the MCP App passes none of these and
  // is unchanged. One slider, one source of truth either way.
  timelineRange?: [number, number];
  onTimelineRangeChange?: (range: [number, number]) => void;
  timelineEnabled?: boolean;
  onTimelineEnabledChange?: (enabled: boolean) => void;
  /** Whether the timeline panel is open — so a search chip can open it. */
  timelineOpen?: boolean;
  onTimelineOpenChange?: (open: boolean) => void;

  // ── Search (the page shell's; the embed never passes these) ───────────────
  /** Matching location ids while a search is active; null renders as today. */
  highlightLocationIds?: ReadonlySet<string> | null;
  /** Dim pins outside the highlight. False when the match list was capped. */
  highlightDimsOthers?: boolean;
  /** The location of the focused search result row, drawn pulsed. */
  pulseLocationId?: string | null;
  /** Rendered first in the top-left control row — where /map puts its search bar. */
  topLeftSlot?: ReactNode;
}

/**
 * The imperative API the page shell drives MapView with — search's click
 * actions. Imperative rather than more props, which is how MapView got long:
 * each of these is a one-shot "do this now", not state.
 */
export interface MapViewHandle {
  /** Fly to an event's location and open its popup pinned, on that event. */
  showEvent(target: {
    locationId: string;
    locationName: string;
    coordinates: [number, number];
    eventId: string;
    sourceId: string | null;
  }): void;
  /** Fly to a location and open its popup pinned at its first in-range event. */
  showLocation(target: {
    locationId: string;
    locationName: string;
    coordinates: [number, number];
  }): void;
  /** Filter to a sequence (plan 18's rendering) and fit to its extent. */
  focusGroup(
    groupId: string,
    bbox: [number, number, number, number] | null,
  ): void;
  /**
   * Draw only these locations — a document's or a person's events — and fit
   * to them. With `path`, `coordinates` are in order (a person's events by
   * date) and a dashed path joins them when they're close enough — plan 18's
   * proximity rule, the same as a sequence; spread out, it's filter-only.
   */
  focusLocations(
    locationIds: string[],
    coordinates: [number, number][],
    opts?: { path?: boolean },
  ): void;
  /** Undo focusGroup/focusLocations. */
  clearFocus(): void;
  closePopup(): void;
  /** The "Limit to view" filter: viewport bbox (lon/lat) and visible sources. */
  getViewFilter(): {
    bbox: [number, number, number, number] | null;
    sourceIds: string[];
  };
}

export const MapView = forwardRef<MapViewHandle, MapViewProps>(function MapView(
  {
    locations,
    initialOverlays,
    initialEventLayers,
    eventGroups = [],
    showNav = true,
    homeHref = "/",
    importHref = "/map/import",
    onRefresh,
    timelineRange: timelineRangeProp,
    onTimelineRangeChange,
    timelineEnabled: timelineEnabledProp,
    onTimelineEnabledChange,
    timelineOpen,
    onTimelineOpenChange,
    highlightLocationIds = null,
    highlightDimsOthers = true,
    pulseLocationId = null,
    topLeftSlot,
  },
  ref,
): JSX.Element {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<Overlay | null>(null);
  const eventsLayerRef = useRef<VectorLayer | null>(null);
  const hoverTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  /**
   * Whether the pointer is inside the popup itself.
   *
   * The popup lives inside the map viewport, so moving through it still fires
   * pointermove on the map — which hit-tests to no pin and schedules the close.
   * Clearing the timer on mouseenter isn't enough, because the very next move
   * re-arms it; the map handler has to stand down entirely while we're in here.
   */
  const isPopupHoveredRef = useRef(false);
  const hoveredLocationIdRef = useRef<string | null>(null);
  const overlayLayersRef = useRef<Map<string, BaseLayer>>(new Map());
  const eventLayersRef = useRef<Map<string, BaseLayer>>(new Map());
  const groupConnectiveLayerRef = useRef<VectorLayer | null>(null);
  /** focusLocations' date-ordered path (a person's events), when drawn. */
  const focusPathLayerRef = useRef<VectorLayer | null>(null);
  const mapRef = useRef<OlMap | null>(null);

  const [eventLayers, setEventLayers] = useState<EventLayer[]>(
    () => initialEventLayers ?? getEventLayers(),
  );
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);

  // Tile/GeoJSON features carry only location_id — the nested location object
  // can't survive MVT encoding, whose properties are flat scalars. Popups
  // resolve detail through this map, identically for both layer kinds.
  const locationsById = useMemo(
    () => new Map(locations.map((l) => [l.id, l])),
    [locations],
  );
  const locationsByIdRef = useRef(locationsById);
  useEffect(() => {
    locationsByIdRef.current = locationsById;
  }, [locationsById]);

  /** The map effect's openPopup, for the imperative handle (it closes over that map's overlay). */
  const openPopupRef = useRef<
    ((stub: HistoricalLocation, pinned: boolean) => Promise<void>) | null
  >(null);
  /** Where an in-progress fly is headed, so a map rebuild mid-fly lands there. */
  const viewTargetRef = useRef<{ center: number[]; zoom: number } | null>(null);
  /** An action deferred until the next map is built (see showEvent). */
  const pendingActionRef = useRef<((map: OlMap) => void) | null>(null);

  // Detail fetched on demand for pins whose events aren't already in memory.
  const locationCacheRef = useRef<Map<string, HistoricalLocation>>(new Map());

  /**
   * A pin's full detail, fetched by id when it didn't travel with the feature.
   *
   * Tile pins carry only scalars, so their events live behind a request. Falls
   * back to the stub when there's nothing to fetch from — offline, or the MCP
   * App's sandbox, which has no origin.
   */
  const loadLocationDetail = useCallback(
    async (stub: HistoricalLocation): Promise<HistoricalLocation> => {
      const cached = locationCacheRef.current.get(stub.id);
      if (cached) return cached;

      try {
        const location = await mapClient.getLocation(stub.id);
        if (!location) return stub;
        locationCacheRef.current.set(stub.id, location);
        return location;
      } catch {
        return stub;
      }
    },
    [],
  );

  const [hoveredLocation, setHoveredLocation] =
    useState<HistoricalLocation | null>(null);
  const [showHomeMarker, setShowHomeMarker] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const isPinnedRef = useRef(false);
  const isDraggingPopupRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [overlays, setOverlays] = useState<HistoricalOverlay[]>(
    initialOverlays ?? DEFAULT_OVERLAYS,
  );
  const [overlayLoadingState, setOverlayLoadingState] = useState<
    Record<string, boolean>
  >({});
  const [internalTimelineRange, setInternalTimelineRange] = useState<
    [number, number]
  >([1776, 2020]);
  const [internalTimelineEnabled, setInternalTimelineEnabled] = useState(false);
  const timelineRange = timelineRangeProp ?? internalTimelineRange;
  const isTimelineEnabled = timelineEnabledProp ?? internalTimelineEnabled;
  const setTimelineRange = useCallback(
    (range: [number, number]) => {
      if (timelineRangeProp === undefined) setInternalTimelineRange(range);
      onTimelineRangeChange?.(range);
    },
    [timelineRangeProp, onTimelineRangeChange],
  );
  const setIsTimelineEnabled = useCallback(
    (enabled: boolean) => {
      if (timelineEnabledProp === undefined)
        setInternalTimelineEnabled(enabled);
      onTimelineEnabledChange?.(enabled);
    },
    [timelineEnabledProp, onTimelineEnabledChange],
  );

  // What the pin style function reads; see PinStyleState.
  const pinStyleStateRef = useRef<PinStyleState>({
    timeline: { enabled: isTimelineEnabled, range: timelineRange },
    highlight: highlightLocationIds,
    dimOthers: highlightDimsOthers,
    pulse: pulseLocationId,
    focus: null,
  });
  /** Re-styles every event layer from pinStyleStateRef, without refetching. */
  const restylePins = useCallback(() => {
    for (const olLayer of Array.from(eventLayersRef.current.values())) {
      olLayer.changed();
    }
  }, []);
  // Which event the next popup should open on (search's event action).
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  const [progress, setProgress] = useState<MapProgress>(() => getProgress());

  /**
   * How much is actually drawn on the map.
   *
   * Not derived from the `locations` prop: on /map that comes from
   * localStorage, while the pins come from the event layers, and the two
   * disagree the moment localStorage is stale. Counting the rendered features
   * is the only answer that matches what the user is looking at.
   */
  const [pinStats, setPinStats] = useState({ locations: 0, events: 0 });
  const totalEvents = pinStats.events;

  const acknowledgedIds = useMemo(
    () => new Set(progress.acknowledgedEventIds),
    [progress],
  );

  const handleAcknowledge = useCallback((eventId: string) => {
    const updated = ackEvent(eventId);
    setProgress(updated);
  }, []);

  // Filter popup events to match timeline range
  const displayLocation = useMemo(() => {
    if (!hoveredLocation || !isTimelineEnabled) return hoveredLocation;
    return {
      ...hoveredLocation,
      // The same precision-aware rule as the pins and search: a year-only
      // event covers its whole year, a circa one a few years either side.
      events: hoveredLocation.events.filter((evt) =>
        eventInYearRange(evt.date, evt.datePrecision, timelineRange),
      ),
    };
  }, [hoveredLocation, isTimelineEnabled, timelineRange]);

  const hoveredLocationRef = useRef<HistoricalLocation | null>(null);
  // Keep refs in sync
  useEffect(() => {
    hoveredLocationRef.current = hoveredLocation;
    hoveredLocationIdRef.current = hoveredLocation?.id ?? null;
    // The popup can go away with the pointer still over where it was (the close
    // button, or the timeline filtering its events out), and then no mouseleave
    // ever arrives. Without this the map would stay stood down for good.
    if (!hoveredLocation) isPopupHoveredRef.current = false;
  }, [hoveredLocation]);

  /**
   * Places the popup where it actually fits: above the pin by default, flipped
   * below when there's no room, and anchored to a side when it would run off a
   * left/right edge.
   *
   * A layout effect because placement needs the card's measured size, which
   * isn't known when openPopup sets the location — the content hasn't rendered
   * yet. Keyed on displayLocation rather than hoveredLocation because that's
   * what actually gets rendered (the timeline can filter events out, changing
   * the height).
   */
  useIsomorphicLayoutEffect(() => {
    const overlay = overlayRef.current;
    const map = mapRef.current;
    const el = popupRef.current;
    if (!overlay || !map || !el || !displayLocation) return;

    const place = () => {
      // Dragging moves the anchor continuously; re-flipping mid-drag would make
      // the card jump out from under the cursor.
      if (isDraggingPopupRef.current) return;

      const position = overlay.getPosition();
      const size = map.getSize();
      if (!position || !size) return;
      const pixel = map.getPixelFromCoordinate(position);
      if (!pixel) return;

      const [anchorX, anchorY] = [pixel[0] as number, pixel[1] as number];
      const [mapWidth, mapHeight] = [size[0] as number, size[1] as number];

      // The cap applies to the scrolling body, so take the header out of it —
      // measured rather than assumed, since a long location name wraps.
      const headerHeight =
        (el.firstElementChild?.firstElementChild as HTMLElement | undefined)
          ?.offsetHeight ?? 0;
      const capBody = (total: number) =>
        el.style.setProperty(
          "--popup-body-max-h",
          `${Math.max(POPUP_MIN_BODY_HEIGHT, total - headerHeight)}px`,
        );

      // Cap to whichever side has more room *before* measuring, so the height
      // we measure is the one that will actually be rendered.
      const { above, below } = verticalSpace(anchorY, mapHeight);
      capBody(Math.max(above, below));

      const placement = choosePopupPlacement({
        anchorX,
        anchorY,
        mapWidth,
        mapHeight,
        popupWidth: el.offsetWidth,
        popupHeight: el.offsetHeight,
      });

      capBody(placement.maxHeight);
      overlay.setPositioning(placement.positioning);
      overlay.setOffset(placement.offset);
    };

    place();
    // A pinned popup would otherwise drift off-screen as the user pans or zooms.
    map.on("moveend", place);
    return () => {
      map.un("moveend", place);
    };
  }, [displayLocation, isPinned]);

  useEffect(() => {
    isPinnedRef.current = isPinned;
  }, [isPinned]);

  // Notify layout of fullscreen changes
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("map-fullscreen-change", { detail: isFullscreen }),
      );
    }
  }, [isFullscreen]);

  // Create map and event features — re-runs when locations change
  useEffect(() => {
    if (!mapContainerRef.current || !popupRef.current) return;

    // Positioning and offset are the defaults; the placement effect below
    // overrides both once it can measure the card. Deliberately no autoPan —
    // it exists to compensate for fixed placement by sliding the whole map,
    // which moves pins out from under the cursor and fights that effect.
    const overlay = new Overlay({
      element: popupRef.current,
      positioning: "bottom-center",
      offset: [0, -POPUP_PIN_GAP],
    });
    overlayRef.current = overlay;

    eventLayersRef.current.clear();
    const pinLayers = eventLayers
      .filter((l) => l.enabled)
      .map((l) => {
        const olLayer = buildEventLayer(l, locations, pinStyleStateRef);
        eventLayersRef.current.set(l.id, olLayer);
        return olLayer;
      });

    // Kept for the timeline effect, which needs a concrete vector source.
    eventsLayerRef.current =
      (pinLayers.find((l) => l instanceof VectorLayer) as VectorLayer) ?? null;

    // Recount whenever a source finishes loading — vector sources fetch lazily
    // on first render, so the counts are zero until then. Tiled (MVT) sources
    // are fetched per tile and have no total to read, so they sit this out.
    const countableSources = pinLayers
      .filter((l): l is VectorLayer => l instanceof VectorLayer)
      .map((l) => l.getSource())
      .filter((s): s is VectorSource => s !== null);

    const recountPins = () => {
      let locationCount = 0;
      let eventCount = 0;
      for (const source of countableSources) {
        for (const feature of source.getFeatures()) {
          locationCount += 1;
          eventCount += (feature.get("event_count") as number) ?? 0;
        }
      }
      setPinStats({ locations: locationCount, events: eventCount });
    };

    countableSources.forEach((s) => s.on("change", recountPins));
    recountPins();

    // This effect rebuilds the map whenever locations or layers change (the
    // 5s poll, a layer toggle). Carry the previous view across, or every
    // rebuild snaps back to the default centre — undoing a search's fly.
    const previousView = mapRef.current?.getView();
    // Mid-fly, carry the fly's destination, not wherever it had got to — a
    // shared ?hit= link flies while the first data load is rebuilding the map.
    const target = viewTargetRef.current;
    const map = new OlMap({
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        ...pinLayers,
      ],
      overlays: [overlay],
      view: new View({
        center:
          target?.center ??
          previousView?.getCenter() ??
          fromLonLat([-111.8881, 40.7606]),
        zoom: target?.zoom ?? previousView?.getZoom() ?? 8,
      }),
      // Drop OL's zoom/rotate buttons. The attribution stays: OSM's ODbL
      // requires it, and ol/source/OSM sets attributionsCollapsible:false so
      // OpenLayers keeps it visible. Deliberately not passing `collapsible` —
      // doing so overrides that safeguard and drops the credit entirely.
      // Compactness is handled by .map-attribution in global.css.
      controls: defaultControls({
        zoom: false,
        rotate: false,
        attributionOptions: { className: "ol-attribution map-attribution" },
      }),
      target: mapContainerRef.current,
    });
    mapRef.current = map;

    // OL measures its target once at construction and caches that size; a
    // frame where the container is briefly 0×0 — mid-hydration, or before a
    // web font finishes loading and reflows the page — leaves the map
    // permanently blank with no error, since nothing after that first measure
    // ever asks it to look again. Only surfaced under a production build: dev
    // mode's slower first paint happens to dodge the race. A ResizeObserver
    // catches every future layout change; `updateSize()` on the next frame
    // catches the construction-time case where the observer hasn't fired yet.
    const resizeObserver = new ResizeObserver(() => map.updateSize());
    resizeObserver.observe(mapContainerRef.current);
    requestAnimationFrame(() => map.updateSize());

    // The above still leaves first paint riding on requestAnimationFrame,
    // which a backgrounded/unfocused tab throttles or pauses outright
    // (verified via document.hidden while debugging a blank map that only
    // painted once a click or drag forced a synchronous render) — a tab
    // opened in the background, or a browser-automation session driving a
    // non-foreground tab, would otherwise sit blank indefinitely with a
    // perfectly correct size and no error. renderSync() paints immediately,
    // independent of rAF ever firing; harmless to call redundantly since OL
    // no-ops a render against an already-current frame.
    map.renderSync();

    // Dev-only console handles, stripped from production builds: the map itself
    // for hit testing and layer state, and the popup/hover refs, which React
    // DevTools can't show. They're refs rather than state because OL's handlers
    // are registered once and would close over stale values. See CLAUDE.md.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __olMap?: OlMap; __olDebug?: unknown }).__olMap =
        map;
      (window as unknown as { __olDebug?: unknown }).__olDebug = {
        popupHovered: isPopupHoveredRef,
        hoverTimeout: hoverTimeoutRef,
        pinned: isPinnedRef,
        hoveredId: hoveredLocationIdRef,
        // What every pin's style is computed from: timeline, search highlight,
        // pulse and focus filter. Lets a spec check the highlight set against
        // real MVT tiles, whose features can't be enumerated.
        pinStyle: pinStyleStateRef,
      };
    }

    /**
     * Opens the popup on a pin, once there is something to show in it.
     *
     * Pins whose events travelled with them (geojson, inline) open on the spot.
     * Tile pins carry only an id, so we wait for the detail rather than opening
     * on a stub, which showed an empty popup for a frame before correcting
     * itself. A pin implies events, so if none arrive we open nothing at all.
     */
    const openPopup = async (
      stub: HistoricalLocation,
      pinned: boolean,
    ): Promise<void> => {
      // A pin opened by hover or click starts on its first event; only the
      // imperative showEvent picks a specific one (and sets it after this).
      setFocusEventId(null);
      const full =
        stub.events.length > 0 ? stub : await loadLocationDetail(stub);
      // The pointer may have moved on while the detail was in flight.
      if (hoveredLocationIdRef.current !== stub.id) return;
      // Nothing to say about this pin: leave the popup shut rather than open an
      // empty one. Shouldn't happen — a pin implies events — but if the detail
      // request fails we show nothing instead of claiming there are no events.
      if (full.events.length === 0) return;

      setHoveredLocation(full);
      overlay.setPosition(fromLonLat(full.coordinates));
      if (pinned) setIsPinned(true);
    };

    // Keep the popup up while the pointer is inside it, so a card can be read
    // without pinning it.
    //
    // Native listeners rather than React's onMouseEnter/onMouseLeave: OL moves
    // this element into its own overlay container, and React's synthetic
    // enter/leave did not fire for it there. Plain mouseenter/mouseleave on the
    // element do, verified against the live map.
    const popupEl = popupRef.current;
    const onPopupEnter = () => {
      isPopupHoveredRef.current = true;
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }
    };
    const onPopupLeave = () => {
      isPopupHoveredRef.current = false;
      if (isPinnedRef.current) return;
      hoverTimeoutRef.current = setTimeout(() => {
        setHoveredLocation(null);
        overlay.setPosition(undefined);
      }, 300);
    };
    popupEl.addEventListener("mouseenter", onPopupEnter);
    popupEl.addEventListener("mouseleave", onPopupLeave);

    openPopupRef.current = openPopup;
    // A popup that was open (pinned, say) stays anchored on the new overlay.
    const shown = hoveredLocationRef.current;
    if (shown) overlay.setPosition(fromLonLat(shown.coordinates));
    // An action that had to wait for this map — showEvent enabling a layer
    // that was off rebuilds the map — runs now, against the new one.
    const pending = pendingActionRef.current;
    pendingActionRef.current = null;
    if (pending) pending(map);

    map.on("pointermove", (evt) => {
      if (evt.dragging) return;
      // Browsing inside the popup — leave it alone until the pointer exits it.
      if (isPopupHoveredRef.current) return;

      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }

      const pixel = map.getEventPixel(evt.originalEvent);
      const feature = map.forEachFeatureAtPixel(pixel, (f) => f, {
        layerFilter: (layer) => layer.get("layerId") === "events",
      });

      if (isPinnedRef.current) {
        map.getTargetElement().style.cursor = feature ? "pointer" : "";
        return;
      }

      if (feature) {
        const locationData = resolveLocation(feature, locationsByIdRef.current);
        if (locationData && locationData.id !== hoveredLocationIdRef.current) {
          hoveredLocationIdRef.current = locationData.id;
          void openPopup(locationData, false);
        }
        map.getTargetElement().style.cursor = "pointer";
      } else {
        hoverTimeoutRef.current = setTimeout(() => {
          setHoveredLocation(null);
          overlay.setPosition(undefined);
        }, 300);
        map.getTargetElement().style.cursor = "";
      }
    });

    map.on("click", (evt) => {
      const pixel = map.getEventPixel(evt.originalEvent);
      const feature = map.forEachFeatureAtPixel(pixel, (f) => f, {
        layerFilter: (layer) => layer.get("layerId") === "events",
      });

      if (feature) {
        const locationData = resolveLocation(feature, locationsByIdRef.current);
        if (locationData) {
          hoveredLocationIdRef.current = locationData.id;
          void openPopup(locationData, true);
        }
      } else {
        if (isPinnedRef.current) {
          setIsPinned(false);
          setHoveredLocation(null);
          overlay.setPosition(undefined);
        }
      }
    });

    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
      popupEl.removeEventListener("mouseenter", onPopupEnter);
      popupEl.removeEventListener("mouseleave", onPopupLeave);
      countableSources.forEach((s) => s.un("change", recountPins));
      resizeObserver.disconnect();
      map.setTarget(undefined);
    };
  }, [locations, eventLayers, loadLocationDetail]);

  // Filter pins by timeline range.
  //
  // Each layer kind applies the same range its own way: geojson layers hide
  // out-of-range features in the pin style function, MVT layers re-request
  // tiles with the range as query params so the filtering happens in PostGIS.
  // TimelineSlider is unaware of either.
  useEffect(() => {
    const [fromYear, toYear] = timelineRange;

    for (const layer of eventLayers) {
      if (layer.kind !== "mvt") continue;
      const source = (
        eventLayersRef.current.get(layer.id) as VectorTileLayer | undefined
      )?.getSource();
      if (!source) continue;
      // Rebuilt from scratch, not appended — `sourceIds` must be included
      // every time or a timeline move silently drops the layer's filter.
      const qs = mvtQueryString({
        sourceIds: layer.sourceIds,
        ...(isTimelineEnabled ? { fromYear, toYear } : {}),
      });
      source.setUrl(`${layer.url}${qs}`);
      source.refresh();
    }
    // Vector layers filter in the pin style function: pins carry their own
    // precision-aware year span (min_year/max_year, the same properties the
    // MVT function emits), so this works without the full event list — and
    // composes with search highlighting rather than overwriting it.
    pinStyleStateRef.current.timeline = {
      enabled: isTimelineEnabled,
      range: [fromYear, toYear],
    };
    restylePins();
  }, [timelineRange, isTimelineEnabled, eventLayers, restylePins]);

  // Search highlighting: re-style in place, never refetch.
  useEffect(() => {
    pinStyleStateRef.current.highlight = highlightLocationIds;
    pinStyleStateRef.current.dimOthers = highlightDimsOthers;
    pinStyleStateRef.current.pulse = pulseLocationId;
    restylePins();
  }, [highlightLocationIds, highlightDimsOthers, pulseLocationId, restylePins]);

  /** Fly rather than cut, so a long jump shows where it went. */
  const flyTo = useCallback((map: OlMap, coordinates: [number, number]) => {
    const view = map.getView();
    const target = {
      center: fromLonLat(coordinates),
      zoom: Math.max(view.getZoom() ?? 8, 10),
    };
    viewTargetRef.current = target;
    view.animate({ ...target, duration: 800 }, () => {
      if (viewTargetRef.current === target) viewTargetRef.current = null;
    });
  }, []);

  useImperativeHandle(ref, (): MapViewHandle => {
    /**
     * Opens a pinned popup from data — never from a synthetic pointer event,
     * because a backgrounded tab has no rendered frame to hit-test against.
     */
    const openPinned = (stub: HistoricalLocation, eventId: string | null) => {
      hoveredLocationIdRef.current = stub.id;
      const open = openPopupRef.current;
      if (!open) return;
      void open(locationsByIdRef.current.get(stub.id) ?? stub, true).then(
        () => {
          if (eventId) setFocusEventId(eventId);
        },
      );
    };

    return {
      showEvent(target) {
        const stub: HistoricalLocation = {
          id: target.locationId,
          name: target.locationName,
          coordinates: target.coordinates,
          events: [],
        };
        const run = (map: OlMap) => {
          flyTo(map, target.coordinates);
          openPinned(stub, target.eventId);
        };
        // Flying to a pin that isn't drawn is the worst result here: turn
        // its source layer on first. Enabling a layer rebuilds the map, so
        // the fly waits for the new one.
        const layer = eventLayers.find(
          (l) =>
            l.id === target.sourceId ||
            (target.sourceId !== null &&
              (l.sourceIds ?? []).includes(target.sourceId)),
        );
        if (layer && !layer.enabled) {
          pendingActionRef.current = run;
          setEventLayers((prev) =>
            prev.map((l) => (l.id === layer.id ? { ...l, enabled: true } : l)),
          );
          return;
        }
        // No map yet (a shared ?hit= link, acted on at load): run once built.
        if (mapRef.current) run(mapRef.current);
        else pendingActionRef.current = run;
      },
      showLocation(target) {
        const run = (map: OlMap) => {
          flyTo(map, target.coordinates);
          openPinned(
            {
              id: target.locationId,
              name: target.locationName,
              coordinates: target.coordinates,
              events: [],
            },
            null,
          );
        };
        if (mapRef.current) run(mapRef.current);
        else pendingActionRef.current = run;
      },
      focusGroup(groupId, bbox) {
        setSelectedGroupId(groupId);
        const map = mapRef.current;
        if (map && bbox) {
          const extent = transformExtent(bbox, "EPSG:4326", "EPSG:3857");
          map.getView().fit(extent, {
            padding: [80, 80, 80, 80],
            maxZoom: 12,
            duration: 600,
          });
        }
      },
      focusLocations(locationIds, coordinates, opts) {
        pinStyleStateRef.current.focus = new Set(locationIds);
        restylePins();
        const map = mapRef.current;
        // No map yet (the MCP App applies focus right after its first
        // render): the filter is set; draw the path and fit once it exists.
        if (!map) {
          pendingActionRef.current = () =>
            this.focusLocations(locationIds, coordinates, opts);
          return;
        }
        if (map) {
          if (focusPathLayerRef.current) {
            map.removeLayer(focusPathLayerRef.current);
            focusPathLayerRef.current = null;
          }
          if (
            opts?.path &&
            coordinates.length > 1 &&
            maxPairwiseDistanceKm(coordinates) <= GROUP_CONNECTIVE_THRESHOLD_KM
          ) {
            const pathLayer = new VectorLayer({
              source: new VectorSource({
                features: [
                  new Feature({
                    geometry: new LineString(
                      coordinates.map((c) => fromLonLat(c)),
                    ),
                  }),
                ],
              }),
              style: new Style({
                stroke: new Stroke({
                  color: "#1e293b",
                  width: 2,
                  lineDash: [6, 4],
                }),
              }),
            });
            pathLayer.set("layerId", "focus-path");
            focusPathLayerRef.current = pathLayer;
            map.addLayer(pathLayer);
          }
        }
        if (map && coordinates.length) {
          const extent = boundingExtent(coordinates.map((c) => fromLonLat(c)));
          map.getView().fit(extent, {
            padding: [80, 80, 80, 80],
            maxZoom: 12,
            duration: 600,
          });
        }
      },
      clearFocus() {
        setSelectedGroupId(null);
        pinStyleStateRef.current.focus = null;
        restylePins();
        if (focusPathLayerRef.current) {
          mapRef.current?.removeLayer(focusPathLayerRef.current);
          focusPathLayerRef.current = null;
        }
      },
      closePopup() {
        isPopupHoveredRef.current = false;
        hoveredLocationIdRef.current = null;
        setHoveredLocation(null);
        setIsPinned(false);
        overlayRef.current?.setPosition(undefined);
      },
      getViewFilter() {
        const map = mapRef.current;
        const size = map?.getSize();
        const bbox =
          map && size
            ? (transformExtent(
                map.getView().calculateExtent(size),
                "EPSG:3857",
                "EPSG:4326",
              ) as [number, number, number, number])
            : null;
        const sourceIds = eventLayers
          .filter((l) => l.enabled)
          .flatMap((l) => l.sourceIds ?? [l.id]);
        return { bbox, sourceIds: Array.from(new Set(sourceIds)) };
      },
    };
  }, [eventLayers, flyTo, restylePins]);

  // Filter/connect pins for a selected Sequence (EventGroup).
  //
  // Simplification: when a group is selected, this takes precedence over the
  // timeline's pin-hiding — group members show regardless of year, since
  // drilling into a named sequence is a deliberate action. The timeline still
  // filters overlays. If the user moves the timeline slider while a group is
  // selected, the timeline effect above will overwrite these per-feature
  // styles on its own next run; the two effects don't coordinate beyond that.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const clearConnectiveLayer = () => {
      if (groupConnectiveLayerRef.current) {
        map.removeLayer(groupConnectiveLayerRef.current);
        groupConnectiveLayerRef.current = null;
      }
    };

    // Falls back to the layer's own style function/style — the same reset
    // the timeline effect uses when disabled.
    const restoreEventStyles = () => {
      for (const olLayer of Array.from(eventLayersRef.current.values())) {
        if (!(olLayer instanceof VectorLayer)) continue;
        const source = olLayer.getSource();
        source
          ?.getFeatures()
          .forEach((feature: Feature) => feature.setStyle(undefined));
      }
    };

    if (!selectedGroupId) {
      clearConnectiveLayer();
      restoreEventStyles();
      return;
    }

    const group = eventGroups.find((g) => g.id === selectedGroupId);
    if (!group) {
      clearConnectiveLayer();
      restoreEventStyles();
      return;
    }

    // Resolve member ids to {event, location} pairs, in memberEventIds order.
    // Unknown ids are skipped rather than thrown on.
    const orderedPairs: {
      event: HistoricalEvent;
      location: HistoricalLocation;
    }[] = [];
    for (const eventId of group.memberEventIds) {
      for (const location of locations) {
        const event = location.events.find((e) => e.id === eventId);
        if (event) {
          orderedPairs.push({ event, location });
          break;
        }
      }
    }

    const memberLocationIds = new Set(
      orderedPairs.map((pair) => pair.location.id),
    );

    // Hide every event pin that isn't a member of this group. MVT layers are
    // left alone — a plain in-memory restyle needs already-loaded vector
    // features, which tile layers don't expose.
    for (const olLayer of Array.from(eventLayersRef.current.values())) {
      if (!(olLayer instanceof VectorLayer)) continue;
      const source = olLayer.getSource();
      source?.getFeatures().forEach((feature: Feature) => {
        const locationId = feature.get("location_id") as string | undefined;
        feature.setStyle(
          locationId && memberLocationIds.has(locationId)
            ? undefined
            : new Style({}),
        );
      });
    }

    if (orderedPairs.length === 0) {
      clearConnectiveLayer();
      return;
    }

    // Number each member's pin with its 1-based sequence order, layered on
    // top of its existing pin style.
    orderedPairs.forEach(({ location }, index) => {
      for (const [layerId, olLayer] of Array.from(
        eventLayersRef.current.entries(),
      )) {
        if (!(olLayer instanceof VectorLayer)) continue;
        const source = olLayer.getSource();
        const feature = source
          ?.getFeatures()
          .find((f: Feature) => f.get("location_id") === location.id);
        if (!feature) continue;

        const eventLayer = eventLayers.find((l) => l.id === layerId);
        const baseStyle = pinStyleFor(eventLayer?.color);
        feature.setStyle(
          new Style({
            image: baseStyle.getImage() ?? undefined,
            text: new Text({
              text: String(index + 1),
              offsetY: -34,
              font: "bold 13px sans-serif",
              fill: new Fill({ color: "#ffffff" }),
              stroke: new Stroke({ color: "#1e293b", width: 3 }),
            }),
          }),
        );
      }
    });

    const coords = orderedPairs.map(
      (pair) => pair.location.coordinates as [number, number],
    );
    const distance = maxPairwiseDistanceKm(coords);

    if (distance > GROUP_CONNECTIVE_THRESHOLD_KM) {
      // Spread out: leave the hide-non-members styling in place, no path,
      // no forced zoom.
      clearConnectiveLayer();
      return;
    }

    const lineFeatures = [];
    for (let i = 0; i < orderedPairs.length - 1; i++) {
      const from = orderedPairs[i]!.location.coordinates;
      const to = orderedPairs[i + 1]!.location.coordinates;
      lineFeatures.push(
        new Feature({
          geometry: new LineString([fromLonLat(from), fromLonLat(to)]),
        }),
      );
    }

    const lineStyle = new Style({
      stroke: new Stroke({ color: "#1e293b", width: 2, lineDash: [6, 4] }),
    });

    let connectiveLayer = groupConnectiveLayerRef.current;
    if (!connectiveLayer) {
      connectiveLayer = new VectorLayer({
        source: new VectorSource({ features: lineFeatures }),
        style: lineStyle,
      });
      connectiveLayer.set("layerId", "group-connective");
      groupConnectiveLayerRef.current = connectiveLayer;
      map.addLayer(connectiveLayer);
    } else {
      const source = connectiveLayer.getSource();
      source?.clear();
      source?.addFeatures(lineFeatures);
    }

    const extent = boundingExtent(coords.map((c) => fromLonLat(c)));
    map.getView().fit(extent, { padding: [80, 80, 80, 80], maxZoom: 12 });
  }, [selectedGroupId, eventGroups, locations]);

  const handleToggleEventLayer = useCallback((id: string) => {
    setEventLayers((prev) =>
      prev.map((l) => (l.id === id ? { ...l, enabled: !l.enabled } : l)),
    );
  }, []);

  const handleClosePopup = useCallback(() => {
    isPopupHoveredRef.current = false;
    setHoveredLocation(null);
    setIsPinned(false);
    overlayRef.current?.setPosition(undefined);
  }, []);

  // Drag-to-reposition for pinned popups
  const handlePopupDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDraggingPopupRef.current = true;
    dragStartRef.current = { x: e.clientX, y: e.clientY };

    const overlay = overlayRef.current;
    const map = mapRef.current;
    if (!overlay || !map) return;

    const startPosition = overlay.getPosition();
    if (!startPosition) return;

    const px = map.getPixelFromCoordinate(startPosition);
    if (!px || px[0] == null || px[1] == null) return;
    const startPixel: [number, number] = [px[0] as number, px[1] as number];

    // Disable map pan while dragging popup
    map.getInteractions().forEach((interaction) => {
      if (interaction.constructor.name === "DragPan") {
        interaction.setActive(false);
      }
    });

    const onMouseMove = (moveEvt: MouseEvent) => {
      if (!isDraggingPopupRef.current || !dragStartRef.current) return;
      const dx = moveEvt.clientX - dragStartRef.current.x;
      const dy = moveEvt.clientY - dragStartRef.current.y;
      const newPixel: [number, number] = [
        startPixel[0] + dx,
        startPixel[1] + dy,
      ];
      const newCoord = map.getCoordinateFromPixel(newPixel);
      if (newCoord) overlay.setPosition(newCoord);
    };

    const onMouseUp = () => {
      isDraggingPopupRef.current = false;
      dragStartRef.current = null;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      // Re-enable map pan
      map.getInteractions().forEach((interaction) => {
        if (interaction.constructor.name === "DragPan") {
          interaction.setActive(true);
        }
      });
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  const handleToggleHomeOverlay = () => {
    if (!mapRef.current) return;
    const hasHomeLayer = mapRef.current
      .getLayers()
      .getArray()
      .some((layer) => layer.get("layerId") === "home");
    if (hasHomeLayer) {
      mapRef.current.removeLayer(homeVectorLayer);
      setShowHomeMarker(false);
    } else {
      mapRef.current.addLayer(homeVectorLayer);
      setShowHomeMarker(true);
    }
  };

  const createOverlayLayer = useCallback(
    async (overlay: HistoricalOverlay): Promise<BaseLayer | null> => {
      const map = mapRef.current;
      if (!map) return null;

      setOverlayLoadingState((prev) => ({ ...prev, [overlay.id]: true }));
      try {
        switch (overlay.source) {
          case "allmaps": {
            if (!overlay.annotationUrl) return null;
            const { WarpedMapLayer, WarpedMapSource } =
              await import("@allmaps/openlayers");
            const warpedMapSource = new WarpedMapSource();
            await warpedMapSource.addGeoreferenceAnnotation(
              overlay.annotationUrl,
            );
            const warpedLayer = new WarpedMapLayer({
              source: warpedMapSource,
              opacity: overlay.opacity,
            });
            warpedLayer.set("overlayId", overlay.id);
            return warpedLayer;
          }
          case "ohm": {
            const ohmLayer = new VectorTileLayer({
              source: new VectorTileSource({
                format: new MVT(),
                url:
                  overlay.tileUrl ||
                  "https://vtiles.openhistoricalmap.org/maps/osm/{z}/{x}/{y}.pbf",
                attributions: overlay.attribution,
              }),
              opacity: overlay.opacity,
              style: createOHMStyle(),
            });
            ohmLayer.set("overlayId", overlay.id);
            return ohmLayer;
          }
          case "usgs": {
            const usgsLayer = new TileLayer({
              source: new TileWMS({
                url:
                  overlay.tileUrl ||
                  "https://basemap.nationalmap.gov/arcgis/services/USGSImageryTopo/MapServer/WMSServer",
                params: { LAYERS: "0" },
                attributions: overlay.attribution,
              }),
              opacity: overlay.opacity,
            });
            usgsLayer.set("overlayId", overlay.id);
            return usgsLayer;
          }
          case "custom": {
            if (!overlay.tileUrl) return null;
            const customLayer = new TileLayer({
              source: new XYZ({
                url: overlay.tileUrl,
                attributions: overlay.attribution,
              }),
              opacity: overlay.opacity,
            });
            customLayer.set("overlayId", overlay.id);
            return customLayer;
          }
          default:
            return null;
        }
      } catch (error) {
        console.error(
          `Failed to create layer for overlay ${overlay.id}:`,
          error,
        );
        return null;
      } finally {
        setOverlayLoadingState((prev) => ({ ...prev, [overlay.id]: false }));
      }
    },
    [],
  );

  const handleToggleOverlay = useCallback(
    async (id: string) => {
      const map = mapRef.current;
      if (!map) return;

      setOverlays((prev) =>
        prev.map((o) => (o.id === id ? { ...o, enabled: !o.enabled } : o)),
      );

      const overlay = overlays.find((o) => o.id === id);
      if (!overlay) return;

      const existingLayer = overlayLayersRef.current.get(id);

      if (overlay.enabled) {
        if (existingLayer) {
          map.removeLayer(existingLayer);
          overlayLayersRef.current.delete(id);
        }
      } else {
        if (existingLayer) {
          map.addLayer(existingLayer);
        } else {
          const newLayer = await createOverlayLayer(overlay);
          if (newLayer) {
            overlayLayersRef.current.set(id, newLayer);
            const layers = map.getLayers().getArray();
            const eventsLayerIndex = layers.findIndex(
              (l) => l.get("layerId") === "events",
            );
            if (eventsLayerIndex > 0) {
              map.getLayers().insertAt(eventsLayerIndex, newLayer);
            } else {
              map.addLayer(newLayer);
            }
          }
        }
      }
    },
    [overlays, createOverlayLayer],
  );

  const handleOpacityChange = useCallback((id: string, opacity: number) => {
    setOverlays((prev) =>
      prev.map((o) => (o.id === id ? { ...o, opacity } : o)),
    );
    const layer = overlayLayersRef.current.get(id);
    if (layer) layer.setOpacity(opacity);
  }, []);

  const handleAddOverlay = useCallback(
    async (overlay: HistoricalOverlay) => {
      setOverlays((prev) => [...prev, overlay]);
      if (overlay.enabled && mapRef.current) {
        const newLayer = await createOverlayLayer(overlay);
        if (newLayer) {
          overlayLayersRef.current.set(overlay.id, newLayer);
          const map = mapRef.current;
          const layers = map.getLayers().getArray();
          const eventsLayerIndex = layers.findIndex(
            (l) => l.get("layerId") === "events",
          );
          if (eventsLayerIndex > 0) {
            map.getLayers().insertAt(eventsLayerIndex, newLayer);
          } else {
            map.addLayer(newLayer);
          }
        }
      }
    },
    [createOverlayLayer],
  );

  const handleRemoveOverlay = useCallback((id: string) => {
    const map = mapRef.current;
    if (!map) return;
    setOverlays((prev) => prev.filter((o) => o.id !== id));
    const layer = overlayLayersRef.current.get(id);
    if (layer) {
      map.removeLayer(layer);
      overlayLayersRef.current.delete(id);
    }
  }, []);

  const handleReorderOverlays = useCallback(
    (reorderedOverlays: HistoricalOverlay[]) => {
      setOverlays(reorderedOverlays);
      const map = mapRef.current;
      if (!map) return;
      const layers = map.getLayers();
      reorderedOverlays.forEach((overlay) => {
        const layer = overlayLayersRef.current.get(overlay.id);
        if (layer && overlay.enabled) {
          layers.remove(layer);
          const eventsLayerIndex = layers
            .getArray()
            .findIndex((l) => l.get("layerId") === "events");
          if (eventsLayerIndex > 0) {
            layers.insertAt(eventsLayerIndex, layer);
          } else {
            layers.push(layer);
          }
        }
      });
    },
    [],
  );

  const minYear = Math.min(...overlays.map((o) => o.yearRange[0]));
  const maxYear = Math.max(...overlays.map((o) => o.yearRange[1]));

  const filteredOverlays = isTimelineEnabled
    ? overlays.filter(
        (o) =>
          o.yearRange[1] >= timelineRange[0] &&
          o.yearRange[0] <= timelineRange[1],
      )
    : overlays;

  return (
    <div className="relative h-full w-full">
      {/* Floating Controls - Top Left */}
      {showNav && (
        <div className="absolute top-4 left-4 z-20 flex flex-wrap items-start gap-2">
          {topLeftSlot}
          {onRefresh && (
            <button
              onClick={onRefresh}
              className="px-4 py-2 bg-white/90 hover:bg-white dark:bg-slate-800/90 dark:hover:bg-slate-800 text-neutral-800 dark:text-neutral-200 rounded-lg transition-colors text-sm font-medium shadow-lg hover:shadow-xl backdrop-blur-sm"
              aria-label="Refresh map data"
            >
              Refresh
            </button>
          )}
          <a
            href={importHref}
            className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors text-sm font-medium shadow-lg hover:shadow-xl backdrop-blur-sm"
          >
            Import Events
          </a>
        </div>
      )}

      {/* Stats, score and fullscreen — one row, so they can't overlap. Both used
          to position themselves absolutely in the same corner and collide. */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        {/* Hidden on phones, where it would sit on top of the top-left
            controls (search, Refresh, Import) — 390px can't fit both rows. */}
        <div className="hidden sm:block bg-black/60 backdrop-blur-sm px-3 py-2 rounded-lg text-sm text-white shadow-lg whitespace-nowrap">
          {pinStats.locations} location{pinStats.locations !== 1 ? "s" : ""},{" "}
          {pinStats.events} event{pinStats.events !== 1 ? "s" : ""}
        </div>
        <ScoreBadge
          points={progress.points}
          acknowledged={progress.acknowledgedEventIds.length}
          total={totalEvents}
        />
        <button
          onClick={() => setIsFullscreen(!isFullscreen)}
          className="p-2 bg-black/60 hover:bg-black/80 backdrop-blur-sm rounded-lg text-white shadow-lg transition-colors"
          aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
        >
          {isFullscreen ? (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="4 14 10 14 10 20" />
              <polyline points="20 10 14 10 14 4" />
              <line x1="14" y1="10" x2="21" y2="3" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          ) : (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points="15 3 21 3 21 9" />
              <polyline points="9 21 3 21 3 15" />
              <line x1="21" y1="3" x2="14" y2="10" />
              <line x1="3" y1="21" x2="10" y2="14" />
            </svg>
          )}
        </button>
      </div>

      {/* Map Container */}
      <div ref={mapContainerRef} className="h-full w-full" />

      {/* Timeline Slider */}
      <TimelineSlider
        minYear={minYear}
        maxYear={maxYear}
        range={timelineRange}
        onRangeChange={setTimelineRange}
        onToggle={setIsTimelineEnabled}
        isEnabled={isTimelineEnabled}
        {...(timelineOpen !== undefined ? { expanded: timelineOpen } : {})}
        {...(onTimelineOpenChange
          ? { onExpandedChange: onTimelineOpenChange }
          : {})}
      />

      {/* Layer Control */}
      <LayerControl
        eventLayers={eventLayers}
        onToggleEventLayer={handleToggleEventLayer}
        eventGroups={eventGroups}
        selectedGroupId={selectedGroupId}
        onSelectGroup={setSelectedGroupId}
        overlays={filteredOverlays}
        onToggleOverlay={handleToggleOverlay}
        onOpacityChange={handleOpacityChange}
        onAddOverlay={handleAddOverlay}
        onRemoveOverlay={handleRemoveOverlay}
        onReorderOverlays={handleReorderOverlays}
        isLoading={overlayLoadingState}
      />

      {/* Popup */}
      {/* Hover in/out is wired natively in the map effect — see onPopupEnter. */}
      <div ref={popupRef}>
        <MapPopup
          location={displayLocation}
          onClose={handleClosePopup}
          isPinned={isPinned}
          onHeaderMouseDown={handlePopupDragStart}
          acknowledgedIds={acknowledgedIds}
          onAcknowledge={handleAcknowledge}
          focusEventId={focusEventId}
        />
      </div>
    </div>
  );
});
