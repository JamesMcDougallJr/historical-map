# Accessible map experience: keyboard, screen reader, and non-color cues for the OpenLayers map

**Related:** [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (clustering,
density-aware zoom, viewport + time-window fetching - the list in this plan
reuses its viewport + time-window query, and its clusters are the hardest
case for text equivalents),
[38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (the detail
page at `app/events/[slug]/page.tsx` is where every list entry and every
focused pin leads),
[31-shareable-map-state.md](./31-shareable-map-state.md) (the map popup
links to the detail page; the keyboard flow below ends at the same place),
[32-fuzzy-dates.md](./32-fuzzy-dates.md) (uncertain dates must not be
color-only either; this plan settles its open question 6 for pins),
[25-product-backlog.md](./25-product-backlog.md) (step 16, open questions
30-32).

**Changelog:**
- 2026-11-03 - Created from the daily research loop. No plan owned the
  reader side of *using* the map: plan 30 owns how the map behaves at
  scale, plan 38 owns the detail page a reader lands on, plan 39 owns
  reporting an error from that page, but a keyboard-only or
  screen-reader user currently has no planned way to explore the map
  itself. This plan adds that way, and deliberately adds no second map:
  one map, one text companion, kept in sync.

## Why this plan exists

An OpenLayers map is a canvas. To a screen reader it is, by default,
close to invisible: a 2025 WCAG evaluation of 14 digital map tools
found most of them conveying map elements as little more than "Map
region clickable", with all other geographic information blank, and
scored the OpenLayers API at 29% across the sampled criteria. The
canvas is not the product's fault - it is the medium's - but it means
the map's content needs a second, semantic representation, not just a
label on the container.

Three specific gaps, in the order a user hits them:

- **Keyboard users can get stuck or locked out.** Default map embeds
  are a classic keyboard-trap site: arrow keys get hijacked for panning
  and Tab cannot leave the canvas. OpenLayers itself ships an
  accessible-map example (a focusable map element, `tabindex="0"`,
  `+`/`-` to zoom, arrow keys to pan), which shows the building blocks
  exist - but nothing in plans 30 or 31 wires them into `/map`, and no
  plan gives a keyboard user a way to *select* an event, only to move
  the view around.
- **Clusters hide content from everyone who cannot see them.** Plan 30
  clusters nearby pins at low zoom. A cluster labelled "12" is twelve
  events with no text equivalent: a screen-reader user hears a count,
  not what is in it, and a keyboard user has no next step short of
  zooming blindly until the cluster splits.
- **Color alone cannot carry meaning.** The standard failure mode is
  pins distinguished only by color (red vs green, or one hue for
  certain and another for uncertain). That fails WCAG 1.4.1 (use of
  color) and 1.4.11 (non-text contrast) for color-blind and low-vision
  readers, and it is exactly how plan 32's uncertain-date markers
  would fail if they were color-only. Shape and text have to do the
  work color does.

This plan is deliberately narrow. It does not build a separate
accessible version of the site, an audio map, or a data sonification.
It makes the one map operable by keyboard and readable through a
semantic list, and it makes pin meaning survive without color. The
detail page (plan 38) is the payoff: once a keyboard or screen-reader
user can reach an event from the list, everything downstream - reading
it, reporting an error on it (plan 39), sharing it (plan 31) - already
works, because those flows live on ordinary HTML pages.

## The one rule, stated first

**Everything on the map must be reachable and readable without the
map.** If a sighted mouse user can find an event by panning and
clicking a pin, a keyboard user must be able to reach the same event
from the keyboard, and a screen-reader user must be able to read the
same event's title, date, and place from semantic HTML. The canvas is
an enhancement over the list, never the only route to the content.
Any feature added to the map later (a new layer, a new pin style, a
new interaction) ships with its list and keyboard equivalent, or it
does not ship.

## What ships

### 1. A focusable, escapable map container

- The map element is focusable (`tabindex="0"`) with a visible focus
  outline and an `aria-label` naming it ("Historical map") plus short
  on-focus instructions, following the OpenLayers accessible-map
  example: arrow keys pan, `+`/`-` zoom.
- No keyboard trap, ever: Tab moves focus *out* of the map to the
  next page element; arrow keys pan only while the map has focus.
  This is an acceptance criterion with a manual test, not an
  assumption about the library default.
- A "Skip map" link before the map jumps focus past it to the event
  list, so a keyboard user never has to tab through the canvas to get
  to content.
- Escape closes an open popup and returns focus to the element that
  opened it (the pin, the list entry, or the search result). A popup
  that swallows Escape strands keyboard users; this is the same
  focus-return discipline plan 39's form already needs on the detail
  page.
- Map controls (zoom, and any plan 30 density/zoom control) are real
  buttons with accessible names, at least 44x44 CSS pixels, with
  visible focus states. No div-with-onClick controls.

### 2. The event list: the map's text equivalent

This is the core of the plan, and it reuses work already planned
rather than inventing a second data path:

- Below (or beside, on wide screens - see open question 31) the map
  sits a semantic HTML list of the events in the *current* view: the
  same viewport + time-window query plan 30 specifies for fetching
  pins. The list and the pins always show the same set. When the user
  pans, zooms, or moves the timeline, the list updates with them.
- Each entry is a heading-level title, the plan 32 date display
  string (including its uncertainty wording, e.g. "circa 1850", never
  a bare year that hides the fuzziness), the place name, and a link
  to the plan 38 detail page. Clusters expand in the list: a cluster
  of 12 contributes 12 entries, each individually linkable, so a
  cluster is never a dead end for a non-visual user.
- Selecting a list entry pans the map to that event, opens its popup,
  and moves focus to the popup (or to the detail-page link inside it,
  per the focus-return rule above). Selecting a pin highlights the
  corresponding list entry. The two views stay in sync in both
  directions; syncing in only one direction is a half-built feature.
- Screen-reader announcements are debounced and summarized, not
  per-feature. Panning across a dense viewport must not fire dozens
  of announcements. One `aria-live="polite"` region, updated at most
  once per settled view change, announces a summary: "Showing 12 of
  44 events, 1847 to 1869" (counts and range from the same query).
  Individual entries are read by normal list navigation, not by live
  announcements.
- The list is server-renderable HTML for the initial view (the
  default viewport + full timeline), so it exists before any map
  JavaScript runs, and so a no-JavaScript reader still gets the
  default set with links to detail pages. The map then enhances it.
  This also keeps plan 38's indexing story honest: the events are
  reachable as links, not only as canvas features.

### 3. Meaning without color

- Pins never rely on color alone. Whatever distinguishes pins in the
  plan 30 design (and plan 32's uncertain markers in particular) is
  expressed by shape and by text: an uncertain event gets a distinct
  pin shape (hollow or dashed outline) *and* the word "circa" (or its
  plan 32 equivalent) in its popup and list entry. This settles plan
  32's open question 6 on the shape side: pins are *not* uniform, and
  the difference is shape, not hue.
- Text on and around pins meets WCAG contrast: 4.5:1 for text,
  3:1 for non-text elements (pin outlines, cluster counts) per
  WCAG 1.4.3 / 1.4.11. Cluster counts are numerals, not color-coded
  dots.
- Focus indicators on pins and list entries are visible at 3:1
  against adjacent colors (WCAG 2.4.11, focus appearance). The default
  browser outline is acceptable if it meets the ratio; a custom
  outline that fails it is not.

### 4. Motion and timing

- Animated pans, zooms, and timeline transitions (plan 30) respect
  `prefers-reduced-motion`: instant view changes instead of animated
  ones when the user asks for reduced motion. No auto-playing
  timeline animation in v1; if one is added later, it needs a pause
  control and must not move content a screen reader is mid-way
  through reading.
- No time limit on reading a popup or a list entry. Nothing in this
  plan auto-dismisses content.

## What this plan does not do

- No separate "accessible map" page or mode. A mode that has to be
  discovered is a mode most users never find; the list is on the main
  `/map` page for everyone, and sighted mouse users can use it too
  (it doubles as a browseable index of the current view).
- No audio rendering of geography, no sonification, no haptic layer.
  Those are real products, not v1 scope for a one-person review
  pipeline.
- No account, preference storage, or settings page for accessibility
  options in v1. `prefers-reduced-motion` comes from the operating
  system, not from a site setting.
- No change to the data model. Events, pins, and clusters keep their
  plan 30 / plan 32 shapes; this plan adds presentation and
  navigation, not fields. The one exception is presentational: the
  list needs the plan 32 display string, which plan 32 already
  specifies.

## Sequencing

After plan 30 (the list reuses its viewport + time-window fetching,
and clusters are the case that most needs the list) and plan 38 (list
entries link to detail pages that exist). Not a plan 26 pilot blocker:
the pilot's success criterion is ingestion correctness, and the list
is a presentation layer over whatever the pilot publishes. Before
any public launch or SEO push that plan 38 enables, because driving
search traffic to pages whose map is unusable by keyboard or screen
reader is worse than not driving it.

## Acceptance criteria

- [ ] Keyboard-only pass over `/map`: every function a mouse user
  has (pan, zoom, select event, open popup, follow to detail page,
  move the timeline, run a search) completes by keyboard, with no
  trap, and Escape always returns focus somewhere sensible.
- [ ] Screen-reader smoke test (NVDA or VoiceOver, one pass): the
  list reads as a list, each entry gives title, date-with-uncertainty,
  and place, and the live region announces one summary per settled
  view change, not a stream of feature announcements.
- [ ] List/pin parity test: for a scripted set of viewports and
  timeline windows (including a clustered low-zoom view), the list
  and the pin set contain the same events. A mismatch fails the
  build's mocked E2E suite once plan 35's gate exists; until then it
  is a manual checklist item.
- [ ] Automated check: axe (or equivalent) run over `/map` and one
  detail page reports zero critical violations; the run is recorded
  in the PR, and known canvas-tooling false positives are listed
  explicitly rather than waved through.
- [ ] Contrast spot-check: pin text, cluster counts, focus outlines,
  and popup text measured against WCAG 1.4.3 / 1.4.11 ratios, not
  eyeballed.
- [ ] `prefers-reduced-motion` verified in a browser with the
  setting on: pans and zooms jump instead of animating.
- [ ] No new data-model fields, no Splink anywhere (dedup remains
  Jev pairwise judging per the Oct 23 decision), no change to the
  curated-44 retirement plan (they stay noindex detail pages until
  plan 37 tombstones them).

## Open questions (carried to the backlog as 30-32)

- 30. WCAG target: AA is assumed throughout this plan. Is AA the
  bar, or is there a reason to aim at AAA for any criterion (e.g.
  enhanced contrast for map labels)?
- 31. List placement: below the map on all widths, or a side panel
  on wide screens? A side panel keeps map and list simultaneously
  visible but complicates focus order; below-map is simpler and
  stacks naturally on mobile.
- 32. Announcement verbosity: is one summary per settled view
  change enough, or should the live region also announce the
  newly focused event's title when selection changes via the list?
