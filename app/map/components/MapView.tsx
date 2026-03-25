"use client";

import { Feature, Map as OlMap, View, Overlay } from "ol";
import OSM from "ol/source/OSM";
import XYZ from "ol/source/XYZ";
import TileLayer from "ol/layer/Tile";
import TileWMS from "ol/source/TileWMS";
import VectorTileLayer from "ol/layer/VectorTile";
import VectorTileSource from "ol/source/VectorTile";
import MVT from "ol/format/MVT";
import { useEffect, useRef, useState, useCallback } from "react";
import { fromLonLat } from "ol/proj";
import Point from "ol/geom/Point";
import Style from "ol/style/Style";
import Icon from "ol/style/Icon";
import Fill from "ol/style/Fill";
import Stroke from "ol/style/Stroke";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import type { HistoricalLocation, HistoricalOverlay } from "../types";
import { DEFAULT_OVERLAYS } from "../utils/overlays";
import { MapPopup } from "./MapPopup";
import { LayerControl } from "./LayerControl";
import { TimelineSlider } from "./TimelineSlider";
import type BaseLayer from "ol/layer/Base";

// Pin icon SVG as data URL for historical events (module scope - created once)
const EVENT_PIN_SVG = `data:image/svg+xml,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">
  <path fill="#3b82f6" d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z"/>
</svg>
`)}`;

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

export interface MapViewProps {
  locations: HistoricalLocation[];
  initialOverlays?: HistoricalOverlay[];
  /** Show navigation controls (Home link, Import Events link). Defaults true. */
  showNav?: boolean;
  homeHref?: string;
  importHref?: string;
  onRefresh?: () => void;
}

export function MapView({
  locations,
  initialOverlays,
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
  const hoveredLocationIdRef = useRef<string | null>(null);
  const overlayLayersRef = useRef<Map<string, BaseLayer>>(new Map());
  const mapRef = useRef<OlMap | null>(null);

  const [hoveredLocation, setHoveredLocation] =
    useState<HistoricalLocation | null>(null);
  const [showHomeMarker, setShowHomeMarker] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const isPinnedRef = useRef(false);
  const [overlays, setOverlays] = useState<HistoricalOverlay[]>(
    initialOverlays ?? DEFAULT_OVERLAYS,
  );
  const [overlayLoadingState, setOverlayLoadingState] = useState<
    Record<string, boolean>
  >({});
  const [selectedYear, setSelectedYear] = useState(1880);
  const [isTimelineEnabled, setIsTimelineEnabled] = useState(false);

  // Keep refs in sync
  useEffect(() => {
    hoveredLocationIdRef.current = hoveredLocation?.id ?? null;
  }, [hoveredLocation]);

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

    const overlay = new Overlay({
      element: popupRef.current,
      positioning: "bottom-center",
      offset: [0, -10],
      autoPan: { animation: { duration: 250 } },
    });
    overlayRef.current = overlay;

    const eventFeatures = locations.map((location) => {
      const feature = new Feature({
        geometry: new Point(fromLonLat(location.coordinates)),
        locationId: location.id,
        locationData: location,
      });
      feature.setStyle(
        new Style({
          image: new Icon({ anchor: [0.5, 1], src: EVENT_PIN_SVG, scale: 1 }),
        }),
      );
      return feature;
    });

    const eventsLayer = new VectorLayer({
      source: new VectorSource({ features: eventFeatures }),
    });
    eventsLayer.set("layerId", "events");
    eventsLayerRef.current = eventsLayer;

    const map = new OlMap({
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        eventsLayer,
      ],
      overlays: [overlay],
      view: new View({
        center: fromLonLat([-111.8881, 40.7606]),
        zoom: 8,
      }),
      target: mapContainerRef.current,
    });
    mapRef.current = map;

    map.on("pointermove", (evt) => {
      if (evt.dragging) return;

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
        const locationData = feature.get("locationData") as HistoricalLocation;
        if (locationData && locationData.id !== hoveredLocationIdRef.current) {
          setHoveredLocation(locationData);
          overlay.setPosition(fromLonLat(locationData.coordinates));
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
        const locationData = feature.get("locationData") as HistoricalLocation;
        if (locationData) {
          setHoveredLocation(locationData);
          setIsPinned(true);
          overlay.setPosition(fromLonLat(locationData.coordinates));
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
      map.setTarget(undefined);
    };
  }, [locations]);

  const handlePopupMouseEnter = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const handlePopupMouseLeave = useCallback(() => {
    if (isPinned) return;
    hoverTimeoutRef.current = setTimeout(() => {
      setHoveredLocation(null);
      overlayRef.current?.setPosition(undefined);
    }, 300);
  }, [isPinned]);

  const handleClosePopup = useCallback(() => {
    setHoveredLocation(null);
    setIsPinned(false);
    overlayRef.current?.setPosition(undefined);
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
        (o) => selectedYear >= o.yearRange[0] && selectedYear <= o.yearRange[1],
      )
    : overlays;

  return (
    <div className="relative h-full w-full">
      {/* Floating Controls - Top Left */}
      {showNav && (
        <div className="absolute top-4 left-4 z-10 flex flex-wrap gap-2">
          <a
            href={homeHref}
            className="flex items-center gap-2 px-4 py-2 bg-black/70 hover:bg-black/80 backdrop-blur-sm rounded-lg text-white shadow-lg transition-colors text-sm font-medium"
            aria-label="Return to home"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M19 12H5M12 19l-7-7 7-7" />
            </svg>
            Home
          </a>
          <button
            onClick={handleToggleHomeOverlay}
            className="px-4 py-2 bg-primary-color hover:bg-blue-600 dark:hover:bg-blue-500 text-white rounded-lg transition-colors text-sm font-medium shadow-lg hover:shadow-xl backdrop-blur-sm"
            aria-label="Toggle home marker"
          >
            {showHomeMarker ? "Hide" : "Show"} Home
          </button>
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

      {/* Map Container */}
      <div ref={mapContainerRef} className="h-full w-full" />

      {/* Timeline Slider */}
      <TimelineSlider
        minYear={minYear}
        maxYear={maxYear}
        value={selectedYear}
        onChange={setSelectedYear}
        onToggle={setIsTimelineEnabled}
        isEnabled={isTimelineEnabled}
      />

      {/* Layer Control */}
      <LayerControl
        overlays={filteredOverlays}
        onToggleOverlay={handleToggleOverlay}
        onOpacityChange={handleOpacityChange}
        onAddOverlay={handleAddOverlay}
        onRemoveOverlay={handleRemoveOverlay}
        onReorderOverlays={handleReorderOverlays}
        isLoading={overlayLoadingState}
      />

      {/* Popup */}
      <div
        ref={popupRef}
        onMouseEnter={handlePopupMouseEnter}
        onMouseLeave={handlePopupMouseLeave}
      >
        <MapPopup location={hoveredLocation} onClose={handleClosePopup} />
      </div>
    </div>
  );
}
