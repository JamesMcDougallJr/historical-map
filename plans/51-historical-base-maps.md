# Historical base maps: period-appropriate boundaries and map layers

**Related:** [00-README.md](./00-README.md) (phases 05-09), [25-product-backlog.md](./25-product-backlog.md) (product step #27), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, event volume), [29-source-expansion-dedup.md](./29-source-expansion-dedup.md) (OpenHistoricalMap boundary layer), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (timeline cursor, viewport + time-window fetching), [31-shareable-map-state.md](./31-shareable-map-state.md) (share links, layer choice), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model, uncertain markers), [33-source-licensing-attribution.md](./33-source-licensing-attribution.md) (license declarations, attribution), [36-geoparsing-place-disambiguation.md](./36-geoparsing-place-disambiguation.md) (place names), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (semantic list, non-color cues), [42-mobile-map-experience.md](./42-mobile-map-experience.md) (bottom sheet), [43-public-read-surface-protection.md](./43-public-read-surface-protection.md) (third-party tile availability), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (engagement), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands), [50-temporal-playback.md](./50-temporal-playback.md) (cursor, playback).

**Changelog:**
- 2026-11-14 — First version. Fills the gap plan 50 left open on purpose: playback moves the cursor through time, but the ground underneath the pins is still a 2026 map — modern borders, modern place names, modern roads — under events that predate all of them.

## Why this plan exists

Every event on the map is plotted on the present day. An 1849 event sits on borders drawn in 2026, a 1776 event on a coastline of cities that did not exist yet. The pins are historical; the ground is not. That is the map's central anachronism, and it is exactly what the comparables that win on this axis sell:

- **Chronograph** (Interactive Historical World Atlas, 610-2026), **Imperium** (5000 BCE-2026), **Age of Events** (5,000 polities cross-faded as you scrub, capitals updating in real time), and **Animaps** (borders animated year by year) all treat the base map as time-dependent. The territory is the story, not the wallpaper.
- **DatesBack** (4000 BC-2026) ships border snapshots as a first-class feature — the map itself is the dated object.
- **Histropedia** and **Histography** do the opposite: event dots on a static modern map. That is the gap this plan closes — the map's differentiator is that the ground moves with the pins.
- **OpenHistoricalMap (OHM)** is the data source that makes it buildable without drawing a single border ourselves: vector tiles with `start_date` / `end_date` on every feature, premade MapLibre/Mapbox styles (Historic, Railway, Japanese Scroll, Woodblock, via `@openhistoricalmap/map-styles`), and a documented date-filtering contract — filter features by `start_decdate` / `end_decdate` (decimal years) or the map shows anachronisms. OHM publishes no raster tiles, and MapLibre GL JS is its preferred client, which is the one real integration decision in this plan (see below).
- Plan 29 already names OHM as the boundary layer for the ingestion side. This plan is the display side: what the reader sees, when, and how honestly.

## The model: two tiers, one anachronism rule

### The anachronism rule (non-negotiable)

A boundary, place name, or road is shown only inside its validity range. A feature whose `start_decdate` is after the cursor date, or whose `end_decdate` is before it, is not drawn — never shown greyed-out, never shown "for context". Where no historical data exists for the cursor date and region, the map says so plainly ("No historical boundaries for this date here yet") and keeps the modern basemap, rather than passing a modern border off as historical. Fuzzy cursor dates follow plan 32: the filter uses the cursor's strict date (or the interval start when the cursor itself is an interval), and the boundary layer carries plan 32's uncertain marker treatment — a boundary dated only approximately is drawn dashed, never solid.

### Tier 1 (v1): boundary overlay on the modern basemap

- The existing modern basemap stays. On top of it, an OHM boundary layer: administrative boundaries (and, where the style supports it, period place names) from the general vector tileset (`https://vtiles.openhistoricalmap.org/maps/osm/{z}/{x}/{y}.pbf`), filtered by the plan 30 / plan 50 cursor date on `start_decdate` / `end_decdate`.
- The `ohm_admin` boundary-polygon tileset is the heavy one — tiles are much larger and slower, and OHM's own guidance is to filter it heavily. So tier 1 uses it sparingly: boundaries as linear features from the general tileset by default, polygons only for the selected event's polity or at low zoom where a fill is the point. Measure before promising fills everywhere.
- The layer is a toggle in the map toolbar (plan 30), labelled with the date it represents: "Boundaries as of 1849". The date label is part of the control, not a footnote — a reader must never have to guess which year the borders belong to.
- **Coverage honesty first.** OHM coverage is uneven: stronger after 1800, stronger in the West. Before promising the toggle everywhere, measure coverage over the plan 26 pilot's event set (share of pilot events whose date/region has boundary data at the cursor date). Where coverage is thin, the toggle defaults off and the empty state above applies. The pilot measurement, not a guess, sets the default.

### Tier 2 (v2): full historical basemap swap

- Replace the modern basemap entirely with an OHM style (Historic first) so roads, water, and labels are also period-appropriate. This is a bigger step because the repo's map is OpenLayers (`ol`, `@allmaps/openlayers`) and OHM's styles are MapLibre/Mapbox style JSON with no raster tiles: the spike in step 0 must confirm the bridge — `ol-mapbox-style` applying the OHM style to an OpenLayers `VectorTile` layer is the standard candidate — against the repo's pinned `ol` version, including the date-filter re-evaluation per cursor move. If the bridge cannot do it cleanly, the honest alternative is a second renderer (MapLibre GL JS alongside OpenLayers for the base layer only), and that is a product decision for James, not a quiet engineering call — see open question 64.
- Tier 2 is explicitly gated on tier 1 shipping and on the coverage measurement. A full basemap swap over thin data is worse than no swap: a blank 1500s map with no features reads as broken, while a modern basemap with a boundaries overlay reads as honest.

### Tier 3 (stretch, in this plan as a defined later step): georeferenced map sheets

- The repo already depends on `@allmaps/openlayers`. A contemporary map sheet (David Rumsey, Allmaps annotations, IIIF) overlaid for a selected event or region is the highest-fidelity version of this feature — the reader sees the map people actually used. It is tier 3 because it is curated, not automatic: somebody picks which sheet belongs to which event/region, the sheet's date and provenance are shown, and a sheet is never auto-matched by place name alone. No step in this plan builds automatic sheet selection.

## Performance: re-evaluate styles, never re-fetch per frame

- The plan 50 rule applies unchanged: the cursor advancing (scrub or playback) re-evaluates the style filter on already-decoded vector features; it never re-fetches tiles per frame. Tile fetching follows the viewport, as today.
- The date filter is a style expression on `start_decdate` / `end_decdate` against one mutable cursor variable — the MapLibre `maplibre-gl-dates` plugin and the OHM Timeslider plugin are the reference implementations of exactly this filter; this plan ports the filter, not the plugins, into the OpenLayers bridge.
- Debounce the filter re-evaluation the same way plan 40 debounces aria-live summaries: one re-evaluation per settled cursor, not per mousemove event while scrubbing.

## Licensing and attribution (plan 33)

- OHM data is public domain unless otherwise noted; the `ohm_land` landmass tileset is ODbL, not public domain — tier 1 does not use it unless the plan 33 license declaration is extended to cover it. The adapter declares the license at the boundary; the popup Sources line and the `/sources` page name OHM wherever the layer is on.
- Tiles are fetched client-side from `vtiles.openhistoricalmap.org` — a third-party host. Plan 43's rate limits do not apply to a host we do not control, so the plan's availability rule is a fallback instead: on tile error or timeout the layer fails back to the modern basemap with the toggle marked unavailable, never a spinner that never resolves. Whether to proxy tiles through our own host (plan 43 posture, caching, and cost) is a later decision, not a v1 requirement.

## Accessibility and surfaces

- Boundaries carry meaning, not decoration: the plan 40 semantic event list names the polity/place as of the cursor date alongside the event, and boundary styles never rely on color alone — historical boundaries are dashed with a label, modern ones solid, so the distinction survives grayscale and color-blindness (plan 40's shape-and-text rule).
- **Toolbar (plan 30) / bottom sheet (plan 42):** the layer control is a basemap switcher with the date label; on mobile it lives in the bottom sheet with plan 42's 44pt targets. The toggle state is reader preference, persisted like the minor-events toggle (plan 46).
- **Plan 31 share links:** a shared link carries the base-layer choice and the cursor year, so the recipient sees the same ground the sender saw — and opens paused, per plan 50.
- **Plan 38 detail pages:** a detail page links back to the map at the event's date with the boundary layer on, so the event's ground matches its date on arrival.
- **Plan 44 analytics:** layer toggles, basemap swaps, and "no historical boundaries here" empty states are first-party events. The weekly review asks whether readers turn the layer on and leave it on — the signal for whether tier 2 is worth building.

## What this plan does not do

- No border animation across snapshots. Dated snapshots are this plan; animating between them is plan 50's cursor job, unchanged.
- No OHM data ingestion into Postgres. Tiles are read live from OHM, not stored — plan 29's boundary layer as ingested data is a separate decision, and storing a third party's vector tiles would need its own plan 33 treatment.
- No automatic Allmaps sheet selection, no editing of OHM data, no new geocoding (plan 36 owns place resolution; this plan only displays what OHM returns for a date).
- Does not change plan 30's clustering, plan 32's date model, or plan 46's bands: the boundary layer consumes the cursor and adds no new rule to any of them.

## Sequencing

- After plans 29 (OHM named as the boundary layer), 30 (timeline cursor, viewport fetching), 32 (date model), 40 (keyboard, semantic list, non-color cues), and 50 (the cursor exists and moves). The display primitives must exist before the ground moves with them.
- Before any public launch (plan 45): a modern-only basemap at launch is acceptable, but period boundaries are the feature that makes the map visibly different from Histropedia and Histography. Not a plan 26 pilot blocker — the pilot measures event density and boundary coverage, which size tier 1's default, but the layer itself is display-side and can land after the pilot.
- Step 0 is a spike, not a build: confirm the `ol-mapbox-style` bridge (or the second-renderer alternative) against the repo's pinned `ol` version, and measure OHM boundary coverage over the pilot's event set. Both results are recorded in this plan before tier 1 is built.

## Done when

- The boundary overlay renders from OHM vector tiles, filtered by the cursor date on `start_decdate` / `end_decdate`, with the date labelled on the toggle and an honest empty state where no data exists.
- No anachronism in the eval: a sampled set of cursor dates shows no boundary outside its validity range, and fuzzy-date boundaries render dashed with plan 32's marker.
- Coverage over the pilot's event set is measured and recorded, and the toggle default follows the measurement.
- Attribution names OHM per plan 33; the layer fails back to the modern basemap on tile error; share links carry the layer choice and open paused; mobile targets meet plan 42.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Default: once the cursor is set, should the historical-boundary overlay be on by default, or off until the reader turns it on?
- Full basemap swap: is a second renderer (or the `ol-mapbox-style` bridge) worth it for tier 2, or is the boundaries-only overlay enough for v1?
- Sparse coverage: where OHM has no boundaries for the cursor date, show the modern basemap with a "no historical boundaries here yet" note, or hide the toggle entirely for that date/region?
