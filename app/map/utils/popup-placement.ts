// Where the map popup should sit relative to its pin.
//
// Pure so the direction table can be tested without a browser: OpenLayers
// positions the *named point of the overlay* at the anchor, so the card extends
// the opposite way, which is easy to get backwards. "bottom-center" puts the
// card's bottom edge on the pin — i.e. the card renders above it.

/** Clearance between the pin and the popup, in pixels. */
export const POPUP_PIN_GAP = 32;
/** Breathing room kept between the popup and the edge of the map. */
export const POPUP_EDGE_MARGIN = 8;
/** Never squash the popup below this, even in a cramped corner. */
export const POPUP_MIN_HEIGHT = 160;
/** Floor for the scrolling body, once the header has been taken out. */
export const POPUP_MIN_BODY_HEIGHT = 96;

/** The subset of ol/Overlay's Positioning that this module produces. */
export type PopupPositioning =
  | "bottom-left"
  | "bottom-center"
  | "bottom-right"
  | "top-left"
  | "top-center"
  | "top-right";

export interface PopupAnchor {
  /** Pin position, in map pixels. */
  anchorX: number;
  anchorY: number;
  /** Map viewport size, in pixels. */
  mapWidth: number;
  mapHeight: number;
  /** Measured popup size, in pixels. */
  popupWidth: number;
  popupHeight: number;
}

export interface PopupPlacement {
  positioning: PopupPositioning;
  offset: [number, number];
  /** Cap for the popup's height so it always fits the chosen side. */
  maxHeight: number;
}

/** Room above/below the pin, once the gap and edge margin are taken out. */
export function verticalSpace(anchorY: number, mapHeight: number) {
  return {
    above: anchorY - POPUP_PIN_GAP - POPUP_EDGE_MARGIN,
    below: mapHeight - anchorY - POPUP_PIN_GAP - POPUP_EDGE_MARGIN,
  };
}

export function choosePopupPlacement({
  anchorX,
  anchorY,
  mapWidth,
  mapHeight,
  popupWidth,
  popupHeight,
}: PopupAnchor): PopupPlacement {
  const { above, below } = verticalSpace(anchorY, mapHeight);

  // Prefer above, as the map always has; drop below only when it fits better.
  const placeBelow = popupHeight > above && below > above;

  // A pin near the left edge needs the card to grow rightwards, which is what
  // anchoring the card's *left* corner to the pin does.
  const half = popupWidth / 2;
  let horizontal: "left" | "center" | "right" = "center";
  if (anchorX - half < POPUP_EDGE_MARGIN) horizontal = "left";
  else if (anchorX + half > mapWidth - POPUP_EDGE_MARGIN) horizontal = "right";

  return {
    positioning: `${placeBelow ? "top" : "bottom"}-${horizontal}`,
    offset: [0, placeBelow ? POPUP_PIN_GAP : -POPUP_PIN_GAP],
    maxHeight: Math.max(POPUP_MIN_HEIGHT, placeBelow ? below : above),
  };
}
