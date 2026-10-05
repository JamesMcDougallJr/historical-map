import type { Page } from "@playwright/test";

/**
 * `e2e/fixtures.ts`'s `waitForMapReady` checks
 * `source.getFeatures().length > 0` on the "events" layer — correct for the
 * mocked suite's GeoJSON `VectorSource`, but `VectorTileLayer`'s
 * `VectorTileSource` does not populate an aggregate feature list that way;
 * it keeps features per-tile internally. Checked directly against Martin
 * (confirmed a real MVT response with the fixture's properties for the
 * tile covering fx-loc-1's pixel) before concluding this, rather than
 * guessing: the SQL/Martin side was fine, this check just doesn't apply to
 * `kind: "mvt"` layers, which is what every e2e-real map test actually
 * renders (NEXT_PUBLIC_MARTIN_URL is set).
 *
 * Hit-testing at a known pixel works for both source kinds, since it reads
 * the last rendered frame rather than a source's internal feature list —
 * the same technique `findHoverPixel` already uses.
 */
export async function waitForRealMapReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const size = window.__olMap?.getSize();
    return !!size && size[0] > 0 && size[1] > 0;
  });

  const vp = page.viewportSize();
  if (!vp) throw new Error("no viewport");
  const anchor = { x: vp.width / 2, y: vp.height / 2 };

  // Scans a small vertical window above the anchor, same as
  // `findHoverPixel` — the pin icon's drawn tip sits a few px above its
  // exact map-coordinate pixel, so testing only the anchor itself can
  // report "not ready" even once tiles have loaded and rendered.
  await page.waitForFunction(
    ({ x, y }) => {
      const map = window.__olMap;
      if (!map) return false;
      map.renderSync();
      for (let d = 0; d >= -30; d -= 2) {
        const hit = map.forEachFeatureAtPixel([x, y + d], (f) => f, {
          layerFilter: (l) => l.get("layerId") === "events",
        });
        if (hit) return true;
      }
      return false;
    },
    anchor,
    { timeout: 30_000 },
  );
}
