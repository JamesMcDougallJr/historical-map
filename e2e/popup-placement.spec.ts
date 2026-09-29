// Pure-function tests for the direction table behind popup placement — no
// browser needed (see popup-placement.ts's own module comment on why it's
// pure). hover.spec.ts covers the same logic exercised live through a real
// pointer/click, for the one case ample screen room always hits: above,
// centered. These cover the edge-flip cases a centered pin can't reach.
import { test, expect } from "@playwright/test";
import {
  choosePopupPlacement,
  verticalSpace,
  POPUP_PIN_GAP,
  POPUP_EDGE_MARGIN,
  POPUP_MIN_HEIGHT,
} from "../app/map/utils/popup-placement";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 800;
const POPUP_WIDTH = 384; // MapPopup's w-96
const POPUP_HEIGHT = 300;

test("pin with room on every side places the popup above and centered", () => {
  const placement = choosePopupPlacement({
    anchorX: MAP_WIDTH / 2,
    anchorY: MAP_HEIGHT / 2,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    popupWidth: POPUP_WIDTH,
    popupHeight: POPUP_HEIGHT,
  });

  expect(placement.positioning).toBe("bottom-center");
  expect(placement.offset).toEqual([0, -POPUP_PIN_GAP]);
});

test("pin near the top flips the popup below it", () => {
  // Too little room above for the popup, plenty below.
  const anchorY = 50;
  const placement = choosePopupPlacement({
    anchorX: MAP_WIDTH / 2,
    anchorY,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    popupWidth: POPUP_WIDTH,
    popupHeight: POPUP_HEIGHT,
  });

  expect(placement.positioning).toBe("top-center");
  // "top-*" positioning anchors the popup's top edge to the pin, so the card
  // renders below it — offset points down (positive), not up.
  expect(placement.offset).toEqual([0, POPUP_PIN_GAP]);
});

test("pin near the left edge anchors the popup's left edge, not its center", () => {
  const placement = choosePopupPlacement({
    anchorX: 20,
    anchorY: MAP_HEIGHT / 2,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    popupWidth: POPUP_WIDTH,
    popupHeight: POPUP_HEIGHT,
  });

  expect(placement.positioning).toBe("bottom-left");
});

test("pin near the right edge anchors the popup's right edge", () => {
  const placement = choosePopupPlacement({
    anchorX: MAP_WIDTH - 20,
    anchorY: MAP_HEIGHT / 2,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
    popupWidth: POPUP_WIDTH,
    popupHeight: POPUP_HEIGHT,
  });

  expect(placement.positioning).toBe("bottom-right");
});

test("popup height is capped to the room actually available, never below the floor", () => {
  // Cramped on every side: a below-floor cap should still return POPUP_MIN_HEIGHT.
  const placement = choosePopupPlacement({
    anchorX: MAP_WIDTH / 2,
    anchorY: 60,
    mapWidth: MAP_WIDTH,
    mapHeight: 120,
    popupWidth: POPUP_WIDTH,
    popupHeight: POPUP_HEIGHT,
  });

  expect(placement.maxHeight).toBeGreaterThanOrEqual(POPUP_MIN_HEIGHT);
});

test("verticalSpace accounts for both the pin gap and the edge margin", () => {
  const { above, below } = verticalSpace(200, MAP_HEIGHT);
  expect(above).toBe(200 - POPUP_PIN_GAP - POPUP_EDGE_MARGIN);
  expect(below).toBe(MAP_HEIGHT - 200 - POPUP_PIN_GAP - POPUP_EDGE_MARGIN);
});
