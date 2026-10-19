# S2 — The search bar: typed results and what clicking does

Part of [19-search.md](./19-search.md). Consumes the `/api/search` contract
from [20-search-lexical.md](./20-search-lexical.md). It can be built against a
stubbed response as soon as that contract is fixed, the same way
`e2e/fixtures.ts` stubs data today.

## Placement

A single input at the top-left of `/map`, over the map, beside the existing
layer control. `⌘K` / `/` focuses it. **Hidden when `showNav={false}`**, so the
MCP App embedding does not get a search bar. Claude is the search interface
there, and `MapView` changes reach both surfaces (CLAUDE.md).

The search bar lives in the page shell, not in `MapView`. It talks to the map
through a small imperative API that `MapView` exposes (`flyTo`, `openPopup`,
`focusGroup`, `filterToDocument`). The alternative is threading more state
through props, which is how `MapView` got to ~700 lines. This also keeps the
MCP bundle from growing (`npm run build:mcp` bundles everything `MapView`
imports).

## Result rows — the type has to be obvious at a glance

Each row has an icon, a kind label, the title, a one-line snippet with
`<mark>` highlights, and a right-aligned context column:

| Kind     | Icon        | Context column                                                     | Example                                                    |
| -------- | ----------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| Event    | pin         | formatted date (with `datePrecision`!) · place · source colour dot | `Mountain Meadows massacre — Sept 11, 1857 · Cedar City`   |
| Sequence | linked pins | `5 events · 1857` (derived range)                                  | `Mountain Meadows Massacre — 5 events · 1857`              |
| Document | page        | `p.43 · 12 matches` · source name                                  | `The Story of Mexico — p.43 · 12 matches`                  |
| Passage  | quote mark  | `p.43` · document title                                            | `"…the Baker–Fancher party camped…" — p.43 · Utah History` |
| Location | place       | `14 events` · date span                                            | `Salt Lake City — 14 events · 1847–1896`                   |

Results are **grouped by kind with section headers** (decision in 20), with an
optional "Top hit" row first. Semantic-only hits carry a small "by meaning"
marker (`matchedOn` includes only `meaning`). Without it, a result with no
highlighted words reads as a bug.

An event matched through its source quote (`matchedOn` includes `quote`) uses
the quote as its snippet, with the matching words highlighted and a small
"from the source" label plus the paragraph's anchor (`p.43¶2`). The
paragraph doesn't also appear in the Passages group (20 folds them). Tapping
the anchor opens the document panel at that paragraph. Tapping the row runs
the normal event action.

**Dates must go through `formatDate(date, datePrecision, dateText)`**, never
raw. Most ingested events are year-only (50 of the first 60), and a search
result asserting "January 1, 1103" would be the most visible place to repeat
that bug.

**Search follows the timeline; space stays global** (19, decision 3).

- **Timeline enabled:** every search is restricted to its range. A
  non-removable chip under the input shows it, `1500–1600` with a timeline
  icon. Clicking the chip opens the timeline; the chip has no `×`, because
  the timeline control owns the filter. Moving the slider re-runs the open
  search, debounced like typing.
- **Timeline disabled:** no date restriction beyond a date parsed from the
  query.
- **"Limit to view"**, an optional toggle chip, adds the viewport `bbox` and
  visible source layers. Off by default, and not remembered across sessions.

**This needs the timeline state outside `MapView`.** Today `timelineRange` and
`isTimelineEnabled` are `useState` inside `MapView` (around line 364), and the
search bar lives in the page shell. Lift both to `app/map/page.tsx` as
controlled props, with `MapView` keeping its current internal state when the
props are absent. The MCP App renders `MapView` with no search bar and should
keep working unchanged. The alternative, an `onTimelineChange` callback that
mirrors state upward, gives two sources of truth for one slider.

**Conflicts are explained, not empty.** When the response says
`parsed.conflict = "timeline"` (a typed date outside the range), show "1840s is
outside your timeline (1500–1600)" with two buttons: "Search 1840s" (moves the
timeline to the typed range) and "Ignore the date" (searches the words alone
within the timeline).

### Slow search → suggest the timeline

If a search hasn't returned after **~800 ms** and no timeline filter is on,
show a hint under the input while the spinner keeps going:

> Searching everything… **Narrow by time** to speed this up.

"Narrow by time" opens the timeline control. Enabling it re-runs the query
and aborts the slow one (the `AbortController` is already in the plan). Rules:

- It's a client-side timer, because only the client knows the full wait,
  network included. The server's `timing.unfiltered` is a second trigger:
  if an unfiltered search _completed_ but took over the threshold
  (`timing.ms`), show the same hint beside the results, so the next search
  is faster.
- Never show it when a date filter already applied (timeline or a parsed
  date). Suggesting a filter the user already has is noise.
- Show it at most once per session after it's been dismissed, and never on
  typeahead keystrokes that get aborted by the next keystroke. Only a search
  that actually stays in flight counts.
- The 800 ms is a starting constant. Set the real one from the latency
  distribution once S3's hybrid mode exists, since that's the path that can
  actually be slow (a Bedrock call plus passage ranking).

Parsed query chips sit under the input. When the parser recognised a date
range, show `1840–1849 ×`. Removing the chip re-runs the search without the
filter.

## Live map highlighting

While results are open, pins that match the query are highlighted and every
other pin is dimmed. The map becomes part of the result list: you can see
_where_ "massacre" happened before choosing a row.

### The data: every match, not just the top rows

The result list holds at most ~50 hits, but dimming everything else claims
"only these match". If the list is capped and the map uses it, that claim is
false whenever there are more matches than rows. So the highlight gets its
own lightweight request:

```
GET /api/search/matches?q=…&from=…&to=…   (same parsing and filters as /api/search)
→ { locationIds: string[], truncated: boolean }   // capped at ~5,000
```

It runs **lexical only**, always, even after Enter in hybrid mode.
Nearest-neighbour search has no natural "doesn't match" boundary beyond the
relevance floor, so dimming on it would be arbitrary. Semantic hits from the
list still highlight, because the client adds their location ids. The
request is fired alongside the typeahead request and shares its debounce and
abort. When `truncated` is set, nothing is dimmed and only the listed pins
highlight. A wrong "only these" is worse than a weaker highlight.

### The rendering: per location, through a style ref

Pins are **locations**, not events. Both the MVT layer (Martin) and the
GeoJSON layer draw one feature per location, carrying `min_year`/`max_year`.
So the highlight set is location ids, and a location is highlighted when any
of its events match.

- `MapView` takes `highlightLocationIds?: ReadonlySet<string> | null`. `null`
  means no search is active and the map renders exactly as today.
- The set is mirrored into a ref and read by the existing style functions,
  for the same reason as `isPinnedRef`: OL style functions are created once
  and would close over a stale set. Changing it calls `layer.changed()` on
  each events layer. That re-styles **without refetching tiles**, which
  matters on the MVT path, where `source.setUrl` would refetch every tile.
- It composes with the timeline: a pin the timeline hides stays hidden.
  Highlighting never brings back a pin the timeline removed.
- Highlight style: the source colour with a halo, plus a scale bump. Dim
  style: the source colour at ~25% opacity. Dimmed pins don't get a
  different shape or colour, so layer colours still read correctly.
- Hovering or arrowing onto a result row "pulses" that row's pin. The keyed
  highlighted row drives a second, single-id ref.

**The MCP bundle.** `MapView` is shared with the MCP App. The prop is
optional and the embed never passes it, so the App's behaviour is unchanged
and the bundle grows by a style branch, not a feature. Re-run
`npm run build:mcp` anyway, because the bundle is an artifact.

**Performance.** Re-styling every pin on every keystroke is cheap at today's
size, and OL only re-styles features in rendered tiles. If profiling ever
says otherwise, the fix is to debounce the highlight separately (~250 ms,
slower than the list), not to drop the feature.

## Touch and small screens

Tablets are the likely primary touch device, phones the harder case. Three
layouts, chosen by viewport width, not user agent:

| Width                              | Search bar                                                          | Results                       | Panels (document, sequence)                            |
| ---------------------------------- | ------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------ |
| ≥ 1024 (desktop, tablet landscape) | top-left, over the map                                              | dropdown under the input      | side sheet on the right                                |
| 640–1023 (tablet portrait)         | full-width top bar                                                  | dropdown, taller, larger rows | side sheet, ~50% width                                 |
| < 640 (phone)                      | collapsed to a search icon; tapping opens a full-screen search view | full-screen list              | **bottom sheet** with snap points (peek / half / full) |

Rules that matter more than the layout grid:

- **No hover anywhere in search.** The map's popup is hover-driven today
  (`pointermove` + 300 ms debounce). On touch, every search action opens the
  popup **pinned**, which it already does on desktop (see "What clicking
  does"). That keeps the action identical across devices instead of having a
  second code path. Row "pulse on hover" becomes "pulse on focus" so keyboard
  and touch get it too.
- **Touch targets ≥ 44 px** for rows, chips and panel buttons.
- **The on-screen keyboard covers half the screen.** On phone and tablet,
  the result list sizes to `visualViewport.height`, not `100vh`. Tapping a
  result dismisses the keyboard _before_ flying, otherwise the fly target
  lands under the keyboard. Live highlighting is still visible above it on a
  tablet. On a phone, a "Show on map" button collapses the list to a peek so
  the dimmed map is visible.
- **The timeline must be touch-draggable** (it's the primary filter). Check
  `TimelineSlider`'s drag handling on touch and its hit-target sizes before
  S2 depends on it. Today it listens for `mousedown`/`touchstart` for
  outside-clicks only, and its drag handles need verifying under touch.
- **No `⌘K` affordance on touch.** Don't show the shortcut hint when
  `(pointer: coarse)`.
- **Bottom sheets and the map share gestures.** A sheet drag must not pan
  the map. Stop propagation at the sheet's drag handle, and give the sheet
  body its own scroll container.
- **Orientation changes** re-run `map.updateSize()`. A tablet rotated with
  the document panel open is the classic way to get the zero-size map warning
  CLAUDE.md lists under stale CSS. It's a real cause here too.

**No libraries** (19, decision on dependencies). The bottom sheet is built
in-house as `app/map/components/BottomSheet.tsx`, and kept deliberately
simple:

- Three snap points (peek / half / full) as CSS heights, with
  `transition: height`.
- A drag handle using pointer events (`setPointerCapture`) that follows the
  finger and, on release, snaps to the **nearest** point. Add a velocity
  rule (a fast flick goes one snap further) only if the touch spec shows
  nearest-snap feels wrong. It's the fiddly part, and it's optional.
- `touch-action: none` on the handle only, so the sheet body scrolls
  natively and the map never sees the drag.
- No inertia physics or rubber-banding. If those ever become necessary, that
  would be the point to reconsider a library, not before.

## What clicking does

This is where the kinds differ. Each action is reversible, and "back" (Esc,
or the browser back button) returns to the result list with the query intact.

### Event

1. Make sure the event is _visible_: if its source layer is toggled off, turn
   it on. The timeline can't be hiding it, because results are already
   filtered to the timeline. The exception is a timeline moved between search
   and click, and the re-run on slider change closes that window. Silently
   flying to a pin that isn't drawn is the worst result here.
2. `flyTo` the location at a sensible zoom.
3. Open the popup **pinned** (`isPinnedRef`), scrolled to the right event when
   the location has several. Reuse `EventTabs`/pagination; don't build a
   second detail view.
4. Highlight the pin briefly.

Watch the CLAUDE.md hit-testing note. The popup must open from data, not from
a synthetic pointer event, because a backgrounded tab has no rendered frame to
hit-test against.

### Sequence

1. Filter the map to the group (`EventQuery.groupId`, built in plan 18).
2. Fit to the group's bbox.
3. Use plan 18's proximity rule for the connective rendering: an ordered path
   and numbered pins when the members are tight, filter-only when they are
   spread out.
4. Open a **sequence panel** listing members in `seq` order. Clicking a member
   runs the event action above.
5. Show a clear "Showing: Mountain Meadows Massacre ×" chip, since the map is
   now filtered and the user needs an obvious way out.

### Document (source file)

**Decided: (c), the document panel** (19, decision 2). The options that were
weighed:

| Option                           | Pro                                          | Con                                                                                                        |
| -------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| (a) Open the PDF at `bestAnchor` | Trivial: the existing `/source#page=N` route | Leaves the map. Loses the document → events relationship, which is the app's whole point.                  |
| (b) Filter map to its events     | Stays spatial                                | A document whose text matched may have zero published events, which gives an empty map and no explanation. |
| (c) Document panel               | Does both, honestly                          | One more panel to build.                                                                                   |

The panel is a side sheet over the map, fed by `GET /api/documents/:id?q=…`
(20). Top to bottom:

1. **Header:** title, source name with its layer colour, and "Open original"
   (`/api/documents/:id/source`, new tab).
2. **Matching passages** for the current query, in document order. Each shows
   its snippet and page, a "p.43 ↗" link to `/source#page=43`, and "show
   event" when the passage has `eventIds`. When the panel was opened without
   a query, this section is hidden.
3. **Events from this document**, as a compact list using `formatDate`. Each
   row runs the event action, and a "Show all on map" button filters the map
   to `documentId` and fits to their extent. It shows the same "Showing: …
   ×" chip as a sequence.
4. **Empty state:** when a document has no published events (text matched,
   but nothing was extracted or everything is in review), say exactly that
   rather than showing an empty list. This is the case option (b) would have
   got wrong.

Filtering by document needs `EventQuery.documentId`. That's a small addition
mirroring `sourceIds`, and it's useful on its own.

### Passage

Opens **the document panel, scrolled to and highlighting that passage**. It
does not open the PDF directly. This keeps the user on the map with the
context (other matches, the document's events) one glance away, and the
page link is right there on the highlighted passage. A passage with
`eventIds` also shows "show event" inline in the result row, so the common
case, "take me to what this paragraph describes", is a single click.

### Location

1. `flyTo` its coordinates. It's global search, so this is often a long jump.
   Use a fly animation rather than a cut so the user can see where they went.
2. Make sure at least one of its events is visible (same layer rule as the
   event action).
3. Open its popup **pinned**, at its first _in-range_ event in date order. The
   popup already filters its events to the timeline (`MapView`'s
   `hoveredLocation` memo). The location
   result is the "go there" action, and the pinned popup's tabs and
   pagination already list everything that happened there.

## Interaction details

- **Debounce** lexical typeahead at about 150 ms. Abort in-flight requests
  (`AbortController`) so slow responses can't overwrite newer ones.
- **Enter** runs hybrid mode once S3 exists (19, decision 3). Before S3,
  Enter selects the top hit.
- Full keyboard navigation (↑/↓/Enter/Esc) and ARIA combobox semantics,
  **hand-built** (no library, 19). It's a single `SearchBox.tsx` following the
  WAI-ARIA APG "combobox with listbox popup" pattern: an `input` with
  `role="combobox"`, `aria-expanded`, `aria-controls` and
  `aria-activedescendant`, and a `role="listbox"` with grouped `role="group"`
  sections, each labelled by its header. The active index is a single number
  across sections, skipping headers. Because accessibility is the part that's
  easy to get subtly wrong, the spec asserts the ARIA wiring explicitly (see
  `search-bar.spec.ts`), rather than trusting a library to have done it.
- Put the state in the URL: `/map?q=…&hit=event:ev-123`. That makes search
  results linkable and shareable and makes back-button behaviour fall out of
  the router.
- Empty and degraded states: "No results", "Source text search unavailable"
  when `modes.documents` is false, and "Search by meaning unavailable" when
  semantic is off.

## E2E specs

All UI specs go in the **mocked** suite, with `/api/search` and
`/api/documents/:id` stubbed. They need deterministic hits at known pixels,
and the real suite can't promise that. A few round-trips run against the
real backend to prove the wiring.

### Fixtures — additions to `e2e/fixtures.ts`

- `mockSearch(page, handler)` routes `**/api/search**` to a handler that
  receives the parsed `URLSearchParams`, so specs can assert on what was
  _sent_ (timeline range, `prefix`, `mode`) as well as control what comes
  back. It also takes an optional `delayMs`, for the slow-search specs.
- `SEARCH_HITS` is one canned hit of each of the five kinds. The event and
  location hits use `TEST_LOCATION`'s coordinates, so the existing "pin at
  dead centre" trick still applies.
- `mockDocument(page, doc)` serves the document-panel endpoint.

Interaction follows the existing conventions in `timeline.spec.ts`. Use
`dispatchEvent("click")` for anything that might sit under the Next dev
overlay portal. Call `__olMap.renderSync()` before any hit test.

### `e2e/search-bar.spec.ts` — the input and the rows

- `⌘K` and `/` focus the input. Esc blurs it and clears the list.
- Typing sends requests with `prefix=1`. Pressing Enter sends one without it.
- **Debounce and abort:** typing `m`, `ma` and `mas` quickly produces one
  request that completes, and earlier in-flight requests are aborted. A stub
  that answers the _first_ request last must not overwrite newer results.
- Each kind renders its section header, icon and kind label, and the row
  text matches the hit, including the context column (date via
  `formatDate`: a `year`-precision hit shows `1857`, never `January 1, 1857`).
- The "Top hit" row renders when the stub marks one.
- `<mark>` highlighting comes from snippet markers. A snippet containing
  `<img src=x onerror=…>` renders as literal text, and no element is created.
- A semantic-only hit (`matchedOn: ["meaning"]`) shows the "by meaning"
  marker.
- A quote-matched event (`matchedOn` includes `quote`, with a `quotePassage`)
  shows the quote as its snippet with the "from the source" label. Tapping
  its anchor opens the document panel at that paragraph.
- Keyboard: ↑/↓ moves through rows across sections, Enter activates, and the
  combobox ARIA attributes are present (`role="combobox"`,
  `aria-activedescendant` tracks the selection).
- Empty state, plus the degraded states: `modes.documents = false` shows
  "Source text search unavailable".
- **Hidden in the MCP App:** rendering `MapView` with `showNav={false}`
  (the existing embed path) shows no search input.

### `e2e/search-actions.spec.ts` — what clicking does

| Kind                | Asserts after click                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event               | view centre ≈ the hit's coordinates (`__olMap.getView().getCenter()`, within tolerance), `__olDebug.pinned.current === true`, the popup shows the hit's event tab, and its source layer was switched on if the stub made it start off |
| Location            | centre moves (fly, not cut: assert an intermediate centre during the animation), popup pinned at the first in-range event                                                                                                             |
| Sequence            | request for the group's members was made with `group=`, map fit to the bbox, the "Showing: … ×" chip is visible, the sequence panel lists members in `seq` order, and × clears the filter and chip                                    |
| Document            | the document panel opens with header, passages and events. "Show all on map" filters by `documentId` and shows the chip. "Open original" has `target="_blank"` and an href of `/api/documents/:id/source`                             |
| Passage             | the document panel opens **scrolled to and highlighting** that passage (assert it's in the viewport and has the highlight class). The page link ends `#page=N`, and the row's "show event" runs the event action                      |
| Document, no events | the panel shows the "no published events" message, not an empty list                                                                                                                                                                  |

Plus:

- **Back/Esc** from any action restores the result list with the query intact.
- **URL state:** after clicking an event, the URL has `?q=…&hit=event:<id>`.
  Loading that URL fresh reproduces the same map state (centre and pinned
  popup).

### `e2e/search-timeline.spec.ts` — the timeline as the primary filter

- Timeline **off**: requests carry no `from`/`to`, and no timeline chip shows.
- Timeline **on** (1500–1600): every request carries `from=1500&to=1600`,
  and the chip shows `1500–1600` with no ×. Clicking the chip opens the
  timeline control.
- Moving the slider with results open re-runs the search (one debounced
  request with the new range).
- **Conflict:** the stub returns `parsed.conflict = "timeline"` for `q=1840s`.
  The message names both ranges. "Search 1840s" moves the timeline to
  1840–1849 and re-runs. "Ignore the date" re-runs with the date stripped.
- **"Limit to view":** toggling it adds `bbox` and `sources` to the request.
  It's off again after a reload.
- **Timeline lifted out of `MapView`:** the pins' timeline filtering still
  works (the existing `e2e-real` `timeline.spec.ts` must stay green
  unmodified), and the embed path without props still has a working
  internal timeline.

### `e2e/search-slow-hint.spec.ts`

- Stub `delayMs: 1500`, timeline off, press Enter: the hint appears after
  ~800 ms while the spinner is still visible. Clicking "Narrow by time" opens
  the timeline, enabling it fires a new request with `from`/`to`, and the
  slow request is aborted (its late response must not render).
- Same delay, **timeline on:** no hint.
- Same delay, **parsed date in the query:** no hint.
- Fast stub that reports `timing: { ms: 2000, unfiltered: true }`: the hint
  shows beside the results after they arrive.
- **Typeahead doesn't trigger it:** keystrokes 100 ms apart against a slow
  stub, each aborted by the next, show no hint.
- Dismiss, then trigger again: it stays hidden for the rest of the session.

Use Playwright's clock (`page.clock`) for the 800 ms rather than real
sleeps, so the timing specs are deterministic in CI.

### `e2e/search-highlight.spec.ts` — live map highlighting

- Typing fires `/api/search/matches` alongside `/api/search`, with the same
  params and the same abort behaviour.
- With the stub returning `locationIds: [A]` and the map holding pins A and
  B: A's rendered style has the halo and B has the dim opacity. Read this via
  `__olMap`'s layer style function on each feature, not from pixels.
- Clearing the input or pressing Esc restores every pin to its normal style
  (`highlightLocationIds = null`), identical to before the search.
- `truncated: true` → no pin is dimmed.
- **Timeline composition:** with the timeline excluding B, a match on B
  doesn't make it visible.
- **No tile refetch:** across ten keystrokes, the number of Martin tile
  requests doesn't change. On the mocked GeoJSON layer, assert that
  `source.refresh` wasn't called. This is the guard for "re-style, don't
  refetch".
- Arrowing onto a result row pulses that row's pin and only that pin.
- Embed path (`showNav={false}`): no highlight request is ever made.

### `e2e/search-touch.spec.ts` — tablets and phones

Run as two extra Playwright **projects** in the root config, using
`devices["iPad (gen 7)"]` (portrait and landscape) and `devices["iPhone 14"]`,
with `hasTouch: true`. Scope them with `testMatch` to the search specs, so
the existing hover specs don't run on touch devices; hover doesn't exist
there. Use `page.tap()` / `locator.tap()`, not `click()`, so real touch events
fire.

- **Layouts:** iPad landscape shows the desktop layout. iPad portrait shows
  the full-width bar. iPhone shows a search icon that opens the full-screen
  view. Assert each layout's landmark element is visible and the others
  aren't.
- **Tap a result** → popup pinned, map centred, keyboard dismissed (the
  input has lost focus before the fly ends).
- **Phone bottom sheet:** tapping a document opens the sheet at "half".
  Dragging the handle up snaps to "full" and down to "peek". A drag on the
  handle doesn't move the map centre.
- **Touch targets:** every result row, chip and panel button is ≥ 44×44 px
  (bounding box).
- **Rotation:** with the panel open, `page.setViewportSize` to the rotated
  dimensions → `__olMap.getSize()` matches the new container, never `[0, 0]`.
- **Timeline on touch:** drag a slider handle with touch events → the range
  changes, and the open search re-runs with the new `from`/`to`.
- **No `⌘K` hint** is rendered on coarse pointers.
- **Keyboard viewport:** emulate a reduced `visualViewport` height → the
  result list's height fits inside it.

### `e2e-real/specs/map/search.spec.ts` — real wiring, a few cases only

- Type `massacre` on the real `/map`. The `fx-ev-massacre` row appears.
  Click it, and the pinned popup shows that event, against real Martin tiles
  (use `waitForRealMapReady`).
- Enable the timeline at 1500–1600 and search `meadows`. No 1857 rows.
- Type `massacre` and check that the highlighted pin set equals the locations
  of `/api/search/matches` against real Postgres and real Martin tiles.
- Search a word on `fx-doc-1`, click the document, and the panel's events
  list comes from the real `/api/documents/fx-doc-1`.

## Decided (2026-10-08)

1. **Live highlighting: yes.** Matching pins highlight and the rest dim while
   typing. See "Live map highlighting".
2. **Tablets and phones are in scope**, tablets most likely. See "Touch and
   small screens".
