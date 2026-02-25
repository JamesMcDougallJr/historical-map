declare module '@allmaps/openlayers' {
  import type { Layer } from 'ol/layer';
  import type { Source } from 'ol/source';

  export interface WarpedMapSourceOptions {
    imageInfoCache?: unknown;
  }

  export class WarpedMapSource extends Source {
    constructor(options?: WarpedMapSourceOptions);
    addGeoreferenceAnnotation(annotationUrl: string): Promise<string[]>;
    addGeoreferencedMap(map: unknown): Promise<string>;
    removeGeoreferencedMap(mapId: string): Promise<void>;
    clear(): void;
    getMapIds(): string[];
    setOpacity(mapId: string, opacity: number): void;
    getOpacity(mapId: string): number;
    setVisible(mapId: string, visible: boolean): void;
    getVisible(mapId: string): boolean;
  }

  export interface WarpedMapLayerOptions {
    source: WarpedMapSource;
    opacity?: number;
    visible?: boolean;
    extent?: number[];
    zIndex?: number;
    minResolution?: number;
    maxResolution?: number;
    minZoom?: number;
    maxZoom?: number;
    className?: string;
  }

  export class WarpedMapLayer extends Layer {
    constructor(options: WarpedMapLayerOptions);
    getSource(): WarpedMapSource;
  }
}
