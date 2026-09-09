"use client";

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
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
} from "react";
import { fromLonLat, toLonLat } from "ol/proj";
import Point from "ol/geom/Point";
import Style from "ol/style/Style";
import Icon from "ol/style/Icon";
import Fill from "ol/style/Fill";
import Stroke from "ol/style/Stroke";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import GeoJSON from "ol/format/GeoJSON";
import type {
  EventLayer,
  HistoricalEvent,
  HistoricalLocation,
  HistoricalOverlay,
} from "../types";
import { DEFAULT_OVERLAYS } from "../utils/overlays";
import { getEventLayers, mvtQueryString } from "../utils/event-layers";
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
import { getYear } from "../utils/date-utils";
import type BaseLayer from "ol/layer/Base";
import type { FeatureLike } from "ol/Feature";
// Positions OL's controls, overlays and attribution. Imported here rather than
// in a layout so both consumers get it — the Next app and the MCP App bundle.
import "ol/ol.css";

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
 * Builds an OpenLayers layer for an event source, switching on how it's served
 * — directly parallel to createOverlayLayer below.
 *
 * Both kinds emit the same feature properties (location_id, source_id, name,
 * min_year, max_year, event_count), so everything downstream is kind-agnostic.
 */
function buildEventLayer(
  layer: EventLayer,
  locations: HistoricalLocation[],
): BaseLayer {
  const style = pinStyleFor(layer.color);

  if (layer.kind === "inline") {
    const features = locations.map((location) => {
      const years = location.events
        .map((e) => parseInt(getYear(e.date), 10))
        .filter(Number.isFinite);
      return new Feature({
        geometry: new Point(fromLonLat(location.coordinates)),
        // Same property names the other two kinds emit, so hover, click and
        // the timeline treat all three identically.
        location_id: location.id,
        source_id: layer.id,
        name: location.name,
        min_year: years.length ? Math.min(...years) : 0,
        max_year: years.length ? Math.max(...years) : 0,
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
            url: layer.url,
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
  /** Show navigation controls (Home link, Import Events link). Defaults true. */
  showNav?: boolean;
  homeHref?: string;
  importHref?: string;
  onRefresh?: () => void;
}

export function MapView({
  locations,
  initialOverlays,
  initialEventLayers,
  showNav = true,
  homeHref = "/",
  importHref = "/map/import",
  onRefresh,
}: MapViewProps): JSX.Element {
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
  const mapRef = useRef<OlMap | null>(null);

  const [eventLayers, setEventLayers] = useState<EventLayer[]>(
    () => initialEventLayers ?? getEventLayers(),
  );

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
        const res = await fetch(
          `/api/data/locations/${encodeURIComponent(stub.id)}`,
        );
        if (!res.ok) return stub;
        const { location } = (await res.json()) as {
          location: HistoricalLocation;
        };
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
  const [timelineRange, setTimelineRange] = useState<[number, number]>([
    1776, 2020,
  ]);
  const [isTimelineEnabled, setIsTimelineEnabled] = useState(false);
  const [progress, setProgress] = useState<MapProgress>(() => getProgress());

  const totalEvents = useMemo(
    () => locations.reduce((sum, loc) => sum + loc.events.length, 0),
    [locations],
  );

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
      events: hoveredLocation.events.filter((evt) => {
        const year = parseInt(getYear(evt.date), 10);
        return year >= timelineRange[0] && year <= timelineRange[1];
      }),
    };
  }, [hoveredLocation, isTimelineEnabled, timelineRange]);

  // Keep refs in sync
  useEffect(() => {
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
        const olLayer = buildEventLayer(l, locations);
        eventLayersRef.current.set(l.id, olLayer);
        return olLayer;
      });

    // Kept for the timeline effect, which needs a concrete vector source.
    eventsLayerRef.current =
      (pinLayers.find((l) => l instanceof VectorLayer) as VectorLayer) ?? null;

    const map = new OlMap({
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        ...pinLayers,
      ],
      overlays: [overlay],
      view: new View({
        center: fromLonLat([-111.8881, 40.7606]),
        zoom: 8,
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

    // Dev-only handle for debugging hit detection and layer state from the
    // console. Never exposed in production builds.
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __olMap?: OlMap; __olDebug?: unknown }).__olMap =
        map;
      (window as unknown as { __olDebug?: unknown }).__olDebug = {
        popupHovered: isPopupHoveredRef,
        hoverTimeout: hoverTimeoutRef,
        pinned: isPinnedRef,
        hoveredId: hoveredLocationIdRef,
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
      map.setTarget(undefined);
    };
  }, [locations, eventLayers, loadLocationDetail]);

  // Filter pins by timeline range.
  //
  // Each layer kind applies the same range its own way: geojson layers hide
  // out-of-range features in memory, MVT layers re-request tiles with the range
  // as query params so the filtering happens in PostGIS. TimelineSlider is
  // unaware of either.
  useEffect(() => {
    const [fromYear, toYear] = timelineRange;

    for (const layer of eventLayers) {
      const olLayer = eventLayersRef.current.get(layer.id);
      if (!olLayer) continue;

      if (layer.kind === "mvt") {
        const source = (olLayer as VectorTileLayer).getSource();
        if (!source) continue;
        const qs = isTimelineEnabled
          ? mvtQueryString({ fromYear, toYear })
          : "";
        source.setUrl(`${layer.url}${qs}`);
        source.refresh();
        continue;
      }

      const source = (olLayer as VectorLayer).getSource();
      if (!source) continue;
      const style = pinStyleFor(layer.color);
      source.getFeatures().forEach((feature) => {
        if (!isTimelineEnabled) {
          feature.setStyle(style);
          return;
        }
        // Pins carry their own year span, so this works without the full
        // event list — the same properties the MVT function emits.
        const min = (feature.get("min_year") as number) ?? -Infinity;
        const max = (feature.get("max_year") as number) ?? Infinity;
        const inRange = max >= fromYear && min <= toYear;
        feature.setStyle(inRange ? style : new Style({}));
      });
    }
  }, [timelineRange, isTimelineEnabled, eventLayers]);

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
        <div className="absolute top-4 left-4 z-10 flex flex-wrap gap-2">
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

      {/* Stats & Fullscreen - Top Right */}
      <div className="absolute top-4 right-4 z-10 flex items-center gap-2">
        <div className="bg-black/60 backdrop-blur-sm px-3 py-2 rounded-lg text-sm text-white shadow-lg">
          {locations.length} location{locations.length !== 1 ? "s" : ""},{" "}
          {locations.reduce((sum, loc) => sum + loc.events.length, 0)} total
          events
        </div>
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

      {/* Score Badge */}
      <ScoreBadge
        points={progress.points}
        acknowledged={progress.acknowledgedEventIds.length}
        total={totalEvents}
      />

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
      />

      {/* Layer Control */}
      <LayerControl
        eventLayers={eventLayers}
        onToggleEventLayer={handleToggleEventLayer}
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
        />
      </div>
    </div>
  );
}
