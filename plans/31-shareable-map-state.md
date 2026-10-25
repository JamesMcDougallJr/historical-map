# Shareable map state: deep links for views, filters, and events

**Related:** [00-README.md](./00-README.md), [25-product-backlog.md](./25-product-backlog.md) (new product step), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (viewport + time-window fetching: the URL carries the same bbox/time-window state), [14-source-retrieval-and-rag.md](./14-source-retrieval-and-rag.md) (source deep links; this plan is the map-view twin), PR #12 (event sequences surfaced in `/map`'s `MapPopup`/`EventCard`; a shared event link opens that popup), plans 19-24 (search; the search query rides in the URL too).

**Changelog:**
- 2026-10-25 - Created from the daily research loop. Follows plan 30: once the map fetches by viewport + time window, the URL is the natural carrier for that state.

## Why this plan exists

Right now `/map` has no shareable state. You cannot send someone the view you are looking at: no link reproduces your viewport, your timeline window, your search, or the event popup you have open. Every interesting find dies in your tab. That is also the product's cheapest distribution: a historical map spreads when a view of it can be pasted into a message, and the recipient lands on exactly what the sender saw.

Plan 30 makes this timely rather than premature. Its viewport + time-window fetching already defines the state that matters (where, when, what filter); this plan serializes that state into the URL instead of inventing a second state shape. It is deliberately client-only: no new API shape, no schema change, no ingestion work.

## Design

### 1. URL schema (query params, not hash)

Use plain query params so the URL is readable, copyable, and server-legible (a hash fragment is invisible to the server, which matters for the Open Graph stretch in section 5):

- `lat`, `lng`, `z` - map center and zoom (the Google Maps convention: `@{lat},{lng},{z}z` proved this shape reads fine in a URL bar).
- `from`, `to` - timeline window, as years (e.g. `from=1846&to=1847`). Years match how the timeline buckets (plan 30 section 3) and how historical dates are usually discussed; exact-day precision is not what a shared view needs.
- `q` - the search query, when one is active (plans 19-24).
- `event` - the selected event's published id, when a popup is open.

Round coordinates to 4 decimals (~11 m) so links stay short; rounding at that precision is invisible at any zoom the map offers. Omit params at their defaults (no `q` when no search, no `event` when no popup) so a plain `/map` link stays clean. One canonical param order, so the same view always produces the same link.

### 2. Load-time apply (precedence order)

On load, parse and validate everything before the first paint of markers, then apply in this order:

1. Viewport (`lat`/`lng`/`z`): clamp latitude to [-90, 90], longitude to [-180, 180], zoom to the map's min/max. Invalid values fall back to the plan 30 default view; a bad link never whitescreens the map.
2. Time window (`from`/`to`): swap if reversed, clamp to the data range. Applied to the timeline and to the map source (plan 30 section 1: events outside the window are not in the source).
3. Search (`q`): applied on top, exactly as typing it would.
4. Selected event (`event`): opens the existing `MapPopup`/`EventCard` path unchanged, including the `eventGroups` ("Part of: ...") line from PR #12. If the event falls outside the viewport or time window the link describes, the event wins: recenter on it (and widen the time window to include its year if needed) rather than opening a popup for an off-screen event. A link that shows a popup you cannot see is a broken link.

### 3. Live sync + copy

- As the user pans, zooms, scrubs, or searches, the URL updates via `replaceState`, debounced (a few hundred ms). `replaceState`, not `pushState`: every pan must not become a back-button step, or the back button becomes unusable after a minute of exploring.
- A visible "Share" / "Copy link" control in the map chrome copies the current URL (with a copied confirmation). The URL in the address bar is always the current link; the button exists because most people will not think to copy the address bar.
- Back/forward navigation (`popstate`) restores the view from the URL, through the same apply path as load-time. The URL is the single source of truth for restorable state, not a parallel history stack.

### 4. Link stability (the historical-map-specific problem)

Event ids are not forever stable in this repo, and the plan says so instead of pretending otherwise:

- Dedup fusion (plans 11/13, Jev judging) merges duplicate events: a merged-away id should resolve to the surviving event where the fusion record allows it. If plan 13's fusion does not retain a merged-into mapping, that is a gap to record there, not a table to invent here.
- The curated seed (44 events) is slated for deletion (plan 25 step 4, standing directive 2026-10-20): links to curated ids will die with the seed. Accept this: links minted after ingestion lands use stable published ids, and no redirect table is built for throwaway seed rows.
- Unknown `event` id (merged without a mapping, deleted, or mistyped): degrade gracefully, never fail. Drop the popup, land on the described viewport + time window, and say nothing alarming; the view itself is still the shared artifact. A link that lands on the right place and century with no popup beats a link that errors.

Group/sequence links (a URL that opens an `eventGroups` sequence view) are a follow-up, not v1: sequences are a display grouping, not yet a routable view, and v1 should not invent one.

### 5. Open Graph previews (stretch, after v1)

Once v1 works, a shared link should preview well: the Next.js App Router can read the `event` param server-side (`generateMetadata`) and emit the event's title/year as the page title and description, so a pasted link shows what it points at instead of the generic site card. A rendered map-image preview is explicitly out of scope for this plan (it needs a headless render pipeline, not a meta tag). If this stretch lands, it must not slow the map's own load: metadata only, no data fetch in the critical path beyond the single event row.

## Sequencing

1. URL schema + parse/serialize + load-time apply (section 1-2), with validation fallbacks.
2. Live sync (`replaceState`, debounced) + "Copy link" control + `popstate` restore (section 3).
3. Link-stability behavior (section 4): merged-id resolution if plan 13 retains the mapping, graceful degradation otherwise.
4. Open Graph metadata stretch (section 5).

## Testing

- Round-trip: parse(serialize(state)) equals state for viewport, time window, search, and event selection, including edge values (world view, single-year window, empty search).
- Invalid params: out-of-range lat/lng/zoom, reversed `from`/`to`, unknown `event` id, garbage strings - every case lands on a working map, never a blank page or a crash.
- E2E (mocked suite; add `e2e-real` specs once plan 25 bug fix #1 lands): load a link with all params and assert the map centers, the timeline window matches, and the event popup opens; copy the link, paste it into a fresh page, and assert the same view; back-button after panning returns to the linked view.
- Regression: `/map` with no params behaves exactly as before; search filters still apply on top of clustering (plan 30).

## Done when

- Pasting a link reproduces the viewport, timeline window, search query, and open event popup.
- Invalid or stale links degrade to a working view, never an error.
- Back/forward restores linked views; the address bar always holds the current link.
- 00-README index and plan 25 backlog reference this plan.

## Open to James (see chat summary)

- URL shape: readable query params as specified, or a short opaque code (shorter links, but unreadable and needs a lookup store)?
- Event-link stability: accept graceful degradation for merged/deleted events, or build a merged-into redirect table in plan 13's fusion output?
- Open Graph previews: worth doing right after v1, or defer until the map has real shared traffic?
