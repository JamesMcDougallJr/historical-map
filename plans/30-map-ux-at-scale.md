# Map UX at scale: clustering, density-aware zoom, and timeline semantic zoom

**Related:** [00-README.md](./00-README.md), [25-product-backlog.md](./25-product-backlog.md) (product step 2, the next UX cliff), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (the source that makes scale real), [29-source-expansion-dedup.md](./29-source-expansion-dedup.md) (sources #3-4), PR #12 (event sequences surfaced in `/map`'s `MapPopup`/`EventCard`).

**Changelog:**
- 2026-10-24 - Created from the daily research loop. Fills product step 2 of plan 25, which had no plan of its own: the map is navigable at 44 events and will not be at 4,400.

## Why this plan exists

Everything upstream of this plan is about getting more events onto the map: plan 26 (Wikidata, global), plan 28 (Britannica link layer), plan 29 (Muffinlabs as source #3, OpenHistoricalMap as a boundary layer). None of them changes what `/map` does when those events arrive. Today the map opens on the whole world (Oct 14 change) and serves 44 hand-curated events across 34 locations; every marker can be shown at once and the timeline can list everything. At 4,400 events, whole-world view becomes a blob of overlapping markers and a timeline strip nobody can scrub. This plan is the display-side counterpart to the ingestion plans: it decides, before the second source lands, how the map stays readable as event count grows 100x.

It is deliberately display-only. It changes no ingestion stage, no schema, and no source adapter. If it needs a new API shape (viewport + time-window queries), that shape is specified here and built as part of this plan, not smuggled into plan 26.

## The scale ladder

Design for three rungs, and do not build rung 3 before rung 1 is measured:

1. **Hundreds of events (now through source #2).** Client-side clustering is enough. OpenLayers' own cluster example renders 20,000 features through `ol/source/Cluster` with a cached style per cluster size, and click-to-fit on a cluster's extent. The map's stack is already OpenLayers (`ol`, `@allmaps/openlayers`), so this is a layer change, not a new dependency.
2. **Thousands to tens of thousands (sources #3-4 and beyond).** Client-side clustering still renders, but shipping every event to the browser on load does not scale: payload, parse time, and memory all grow linearly. This rung needs viewport + time-window fetching: the client asks for only the events in the current map extent and timeline window, and refetches on pan/zoom/scrub (debounced, with the previous window kept on screen until the new one lands so the map never flashes empty).
3. **Hundreds of thousands (only if ingestion ever gets there).** Server-side aggregation: the API returns cluster counts per tile/grid cell at low zooms and individual events only past a zoom threshold. Do not build this now; the plan records the threshold that triggers it (measured client render time, not a guessed event count) so a future agent does not have to re-derive it.

## Design

### 1. Cluster layer (rung 1, build first)

- Wrap the existing event point source in `ol/source/Cluster` with a pixel `distance` (start at 40, tune by feel) and a `minDistance` so clusters do not collapse onto each other.
- Cache styles by cluster size exactly as the OpenLayers example does: one `Style` per size, never a fresh style object per feature per frame. Style function cost is the classic OpenLayers perf trap at scale.
- Cluster badge shows the count. Clicking a cluster with more than one member fits the view to the members' extent (animated, with padding), the same interaction as the official example. Clicking a single-event cluster opens the existing `MapPopup`/`EventCard` path unchanged, including the `eventGroups` ("Part of: ...") line from PR #12.
- Clusters must respect the timeline window: an event outside the selected time range is not in the source at all, not merely hidden. Otherwise counts lie ("12 events here" when the timeline shows 2).
- Same-place-different-event stacks (many events, one location, e.g. a city with 30 events across centuries) are the hard case for pure spatial clustering: at max zoom they still overlap. Handle with a cluster-list popup: clicking a same-coordinate cluster that cannot be split by zooming further opens a list of its members (title + year) instead of zooming forever. This is the map-side twin of the timeline density problem below.

### 2. Density-aware zoom and default view (rung 1-2)

- The whole-world default view is fine at 44 events and wrong at 4,400: it guarantees the worst density on first paint. Once event count passes a measured threshold (start the conversation at 500 visible markers), the default view should fit the extent of the *filtered* set (timeline window + any search filter), not the world, with a world-view button to reset.
- Zoom behavior: below a zoom threshold, show clusters only; individual markers appear only when the map is zoomed in enough that they can be told apart. The threshold is a product decision to tune by feel, recorded as a constant with a comment, not buried in a style function.
- Do not auto-zoom on every filter change: a user who deliberately framed a region should not have the map yanked away when they scrub the timeline. Fit-to-filtered-extent happens on explicit actions (first load, "reset view", a search result selection), never as a side effect of scrubbing.

### 3. Timeline semantic zoom (rung 1-2)

Dense timelines fail the same way dense maps do: hundreds of events in one century become an unreadable strip. Apply the same ladder to time that section 1 applies to space:

- **Overview (zoomed out):** the timeline shows aggregated density, not individual events: a histogram/bar per bucket (bucket width scales with the visible range: centuries at world-history scale, decades closer in, years closest). A bucket click zooms the timeline to that bucket.
- **Detail (zoomed in):** individual events appear, with same-year stacks collapsed into an expandable "N events" group (the time twin of the same-coordinate cluster list).
- **Progressive disclosure throughout:** the timeline never tries to render every event label at once; labels appear only for the visible window at the current zoom, exactly as the map shows only the visible extent.
- The map and the timeline stay in sync: scrubbing the timeline filters the map source (section 1), and the map's visible extent does not change on scrub (section 2). Two controls, one filtered set.

### 4. Viewport + time-window fetching (rung 2, build when rung 1 is measured slow)

- New query shape on the existing data endpoints (extend `/api/data/locations` or add a sibling; the coding agent verifies which endpoint the map actually reads before adding a second one): `bbox`, `start`, `end`, plus the existing search/group filters. Response stays the same event shape so the cluster layer does not change.
- Client contract: debounce refetches on pan/zoom/scrub; keep the previous window rendered until the new response lands; cancel in-flight requests superseded by a newer viewport (do not let a stale slow response overwrite a fresh one).
- Cache by (bbox bucket, time window) so scrubbing back and forth across the same range does not refetch. Bucket the bbox to a coarse grid so tiny pans do not bust the cache.
- This is the point where the e2e-real suite matters: viewport fetching adds network timing to the map's critical path, so the real-backend suite (red on main since Oct 19, plan 25 bug fix #1) must be green before this section lands, or its regressions will be invisible.

## Sequencing

1. Cluster layer + same-coordinate list popup + timeline bucketing (rung 1). Measure: frame time and load time at 44 events, and again against a synthetic 5,000-event fixture (generated, not real ingestion) so the numbers exist before real scale arrives.
2. Default-view / fit-to-filtered-extent behavior + zoom thresholds (rung 1-2).
3. Viewport + time-window fetching (rung 2), gated on the e2e-real suite being green and on measured rung-1 slowness, not on a calendar date.
4. Server-side aggregation (rung 3) only when rung-2 measurements say the client cannot keep up. Record the trigger measurement in this plan when it happens; do not pre-build.

## Testing

- Fixture-driven: a synthetic 5,000-event dataset (spread globally, with deliberate same-coordinate stacks and same-year stacks) renders clustered at world view with no single marker blob; cluster counts equal the filtered set, never the unfiltered total.
- Interaction: clicking a multi-member cluster zooms to its extent; clicking a same-coordinate cluster at max zoom opens the member list; timeline bucket click zooms the timeline and filters the map to that bucket.
- Regression: the existing `MapPopup`/`EventCard` path (including `eventGroups`) works unchanged for a single event reached through a cluster; search filters still apply on top of clustering.
- Perf: record frame time and initial load at 44 events and at the 5,000-event fixture, before and after; the plan's rung-2 trigger is a measured regression, not a vibe.
- E2E: new specs run in both the mocked suite and `e2e-real` (once bug fix #1 lands); viewport-fetch specs assert stale responses never overwrite fresh ones.

## Done when

- `/map` clusters at world view with cached styles, count badges, click-to-fit, and a same-coordinate member list; the timeline shows bucketed density zoomed out and individual events zoomed in.
- The map never shows a count or a marker for an event outside the current timeline window.
- Measured perf numbers at 44 and 5,000 events are recorded in this plan, with the rung-2/rung-3 triggers stated as numbers.
- 00-README index and plan 25 backlog reference this plan.

## Open to James (see chat summary)

- Default view at scale: fit-to-filtered-extent on load, or keep the whole-world open and let clusters carry it?
- Same-coordinate stacks: member-list popup, or spiderfy-style fan-out of markers around the point?
- Rung 2 timing: build viewport fetching as soon as source #2 lands, or wait for measured slowness at 5,000 events?
