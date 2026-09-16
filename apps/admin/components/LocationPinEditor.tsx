"use client";

// Purpose-built, minimal map for one job: show a single pin, let it be
// dragged, report the new coordinates. Deliberately not built on top of
// `app/map/components/MapView.tsx` — that component is already shared by two
// surfaces (the web app and the MCP App) with real coupling to timeline/
// overlay/popup state none of which applies here; a third, very different
// consumer shouldn't extend it further.

import { useEffect, useRef } from "react";
import { Collection, Feature, Map as OlMap, View } from "ol";
import TileLayer from "ol/layer/Tile";
import OSM from "ol/source/OSM";
import VectorLayer from "ol/layer/Vector";
import VectorSource from "ol/source/Vector";
import Point from "ol/geom/Point";
import { Translate } from "ol/interaction";
import { fromLonLat, toLonLat } from "ol/proj";
import "ol/ol.css";

interface LocationPinEditorProps {
  coordinates: [number, number]; // [lon, lat]
  onMoved: (coordinates: [number, number]) => void;
}

export function LocationPinEditor({
  coordinates,
  onMoved,
}: LocationPinEditorProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const onMovedRef = useRef(onMoved);
  onMovedRef.current = onMoved;

  useEffect(() => {
    if (!containerRef.current) return;

    const pin = new Feature({ geometry: new Point(fromLonLat(coordinates)) });
    // A Collection (not a plain array) is what makes it possible to hand the
    // same feature set to both the source and `Translate` below — a plain
    // `features: [pin]` array leaves `getFeaturesCollection()` null.
    const features = new Collection([pin]);
    const source = new VectorSource({ features });

    const map = new OlMap({
      target: containerRef.current,
      layers: [new TileLayer({ source: new OSM() }), new VectorLayer({ source })],
      view: new View({ center: fromLonLat(coordinates), zoom: 10 }),
    });

    const translate = new Translate({ features });
    map.addInteraction(translate);
    translate.on("translateend", (evt) => {
      const geom = evt.features.item(0)?.getGeometry();
      if (!(geom instanceof Point)) return;
      const [lon, lat] = toLonLat(geom.getCoordinates());
      if (lon === undefined || lat === undefined) return;
      onMovedRef.current([lon, lat]);
    });

    return () => map.setTarget(undefined);
    // Re-created only when the map first mounts or a *different* location is
    // loaded — re-running on every coordinate change would fight the drag
    // interaction's own in-progress move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [containerRef]);

  return <div ref={containerRef} className="pin-map" />;
}
