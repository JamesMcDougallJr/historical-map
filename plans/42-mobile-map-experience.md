# Mobile map experience: touch-first map, bottom sheet, small screens

**Related:** [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (clustering,
viewport + time-window fetching - the mobile map reuses both, and a
cluster tap replaces the hover tooltip touch cannot have),
[31-shareable-map-state.md](./31-shareable-map-state.md) (most shared
links open on a phone; the sheet state a link lands in is this plan's
state),
[32-fuzzy-dates.md](./32-fuzzy-dates.md) (uncertain markers must stay
legible at small sizes),
[38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail
pages are server-rendered and inherit mobile layout for free; the sheet
links out to them),
[40-accessible-map-experience.md](./40-accessible-map-experience.md)
(the semantic event list is the text equivalent; focus and aria-live
rules carry over to the sheet),
[41-sequence-journeys.md](./41-sequence-journeys.md) (on small screens
the journey player *is* the bottom sheet's step list),
[25-product-backlog.md](./25-product-backlog.md) (step 18, open questions
36-38).

**Changelog:**
- 2026-11-05 - Created from the daily research loop. No plan owned the
  map on a phone: plans 30, 31, 38, 40 and 41 all assume a
  desktop-shaped viewport with hover, a keyboard, and room for an
  anchored popup and a full timeline. The gestures mostly work already
  (OpenLayers ships them); the UI around them does not. This plan is
  the UI: what a tap selects, what replaces the popup, how the timeline
  fits, and how the map stops fighting the page scroll.

## Why this plan exists

A historical map answers "what happened here" wherever the reader is,
and the readers who arrive from a shared link (plan 31) or a search
result (plan 38) mostly arrive on a phone. Today `/map` on a 390px
viewport is the desktop layout shrunk: the popup is anchored to a pin
that may sit under the reader's thumb, the timeline is a desktop strip,
and the controls are mouse-sized. Nothing in plans 30-41 says what
happens instead, so the first reader on a phone gets the worst version
of the product - and that reader is the one a share link or a search
result just worked hardest to win.

The comparable products all converged on the same shape, and this plan
copies it rather than inventing one:

- Google Maps popularised the non-modal bottom sheet: a panel peeking
  from the bottom of the screen, expandable to a mid height for quick
  details and draggable to near full screen for the whole story, while
  the map behind it stays interactive at every height. Three detents
  (peek, half, full) with a grab handle, swipe-down to dismiss, and
  different content per height - a place name when peeked, details
  when half expanded, everything when full. The sheet never takes the
  reader away from the map, which is the whole point: the detail and
  its location stay visible together.
- The Nielsen Norman Group's guidance on the same pattern is the
  constraint that makes it work: a non-modal sheet preserves
  interaction with the background content, while a modal sheet blocks
  it behind a scrim. A map detail sheet must be non-modal - the reader
  pans the map to check the next pin while the sheet is still open.
  A sheet that locks the map out is a dialog wearing a sheet's clothes.
- Touch targets are not a preference: Apple asks for 44x44pt and
  Google for 48x48dp minimums. Every control on the mobile map -
  zoom, close, search, timeline handles - meets one of those, or it
  does not ship.

## What ships

### 1. Gestures: OpenLayers already ships them; configure, don't build

OpenLayers v10's default interaction set is, in order: `DragRotate`,
`DoubleClickZoom`, `DragPan`, `PinchRotate`, `PinchZoom`,
`KeyboardPan`, `KeyboardZoom`, `MouseWheelZoom`, `DragZoom`. One-finger
pan (with kinetic inertia), pinch zoom, and double-tap zoom work out of
the box, and no plan work is needed to get them. The work is three
configuration decisions:

- **Pinch-rotate is off in v1.** Two-finger rotation is the classic
  accidental mobile-map gesture: a reader means to pinch-zoom and the
  map tilts instead, and there is no obvious way back. Disable
  `PinchRotate` (and the Alt-Shift `DragRotate`) until a reader asks
  for rotation, which is open question 36.
- **Pin selection uses `singleclick`, never `click`.** OpenLayers
  delays `singleclick` by about 250ms to disambiguate a double-tap
  zoom; `click` fires on the second tap of that double-tap as well,
  so a zoom gesture would also select a pin. Tap latency of a quarter
  second is the price of not selecting on every zoom.
- **A touch that moves is a pan, never a selection.** If the pointer
  moves beyond a small threshold between down and up, the gesture is
  a drag and no pin is selected, even if it started on one. This is
  the rule that stops "I was panning and a popup opened" complaints.

### 2. The bottom sheet replaces the popup below the breakpoint

Below the small-screen breakpoint the anchored popup does not render
at all. Tapping a pin opens a bottom sheet instead, with three detents
measured in fractions of the dynamic viewport height (`dvh`, so mobile
browser chrome showing and hiding does not clip the sheet): peek
around 20% (title + date), half around 50% (the `EventCard` summary),
full around 90% (the full card, its Sources line per plan 33, and
links out to the plan 38 detail page and the plan 41 journey). The
sheet is non-modal: no scrim, no scroll lock, and the map behind it
stays pannable and zoomable at peek and half. A grab handle at the top
signals draggability; swipe-down or Escape dismisses; expanding to full
is a deliberate drag or tap on the handle, never an accident of
scrolling the sheet's content.

Implementation is a drawer library, not hand-rolled gesture code:
Vaul (a Radix Dialog drawer with snap points, dragging, and
`modal={false}` for the non-modal mode with no overlay) is the first
choice for its Radix accessibility semantics; react-spring-bottom-sheet
with `blocking={false}` is the fallback if Vaul fights the app's
stack. Either way the sheet is one component wrapping the existing
`EventCard`, not a second copy of the event rendering.

The switch is a viewport-width breakpoint, not user-agent sniffing:
a narrow desktop window gets the sheet, a wide tablet gets the popup.
Safe-area insets (`env(safe-area-inset-bottom)`) keep the sheet's
controls clear of the home indicator.

### 3. Touch targets and controls

Every tappable control on the mobile map meets 44x44pt (iOS) /
48x48dp (Android): the zoom +/- buttons get a touch-sized variant,
the sheet close control, the search control, and the timeline handles.
The search bar becomes a full-width top bar on small screens instead
of a floating box. A cluster tap (plan 30) zooms to the cluster's
extent - there is no hover on touch, so no hover tooltip exists
anywhere on the mobile path, and no feature may be reachable only by
hovering.

### 4. The timeline fits a phone

Plan 30's timeline collapses on small screens to a compact strip: a
scrubber with the current window's label and an expand control that
opens the full timeline in the sheet's half detent. Scrubbing drives
the same viewport + time-window query plan 30 specifies; fuzzy spans
(plan 32) keep their uncertain markers at small sizes rather than
collapsing to a point. The timeline never competes with the map for
vertical space: collapsed, it is a strip; expanded, it lives inside
the sheet, not over the map.

### 5. The map stops fighting the page scroll

A map embedded in a scrolling page traps one-finger scroll: the reader
tries to scroll past the map and pans it instead. On small screens
`/map` is a full-viewport app page - the map *is* the page, the sheet
floats over it, and there is no page scroll to fight. If the map is
ever embedded in a scrolling page (an embed, a blog post), the
fallback is OpenLayers' `onFocusOnly` interaction option or an
explicit tap-to-enable affordance, never a silent scroll trap. Open
question 37 asks James to confirm the full-viewport call.

### 6. Performance on touch hardware

Mobile hardware and networks are the constraint, so the mobile map
spends less, not more: cap concurrent tile loads, render
cluster-first from plan 30's viewport + time-window query, and run no
hover-driven prefetch - `pointermove` has no meaning on touch, so
nothing may be fetched on hover. The initial payload is the same
query the desktop map makes; the difference is what the phone is
never asked to do.

### 7. Journeys and detail pages on mobile

Plan 41's journey player *is* the bottom sheet's step list on small
screens: steps advance the sheet, the map recentres behind it, and
Prev / Next are thumb-reachable buttons at the sheet's bottom. Plan
38's detail pages are server-rendered pages and need no mobile work
beyond the responsive layout they already get. A plan 31 share link
opens directly into the sheet state it names - the link a reader taps
in a message thread lands on the event, in the sheet, on their phone.

### 8. Accessibility on touch is plan 40's rules, applied to the sheet

Plan 40's semantic event list remains the text equivalent of the map.
Focus moves to the sheet heading when it opens and returns to the pin
control when it closes; sheet state changes are announced once through
the same debounced aria-live summary plan 40 specifies; and
`prefers-reduced-motion` makes the sheet snap between detents instead
of animating. A journey that only works with a mouse is not done
(plan 41), and a sheet that only works with a finger is not done
either.

## What this plan does not do

- No native app, no app-store wrapper, and no separate m-dot site.
  One responsive web app; the breakpoint decides the UI, not the
  device.
- No PWA or offline map in v1. Tile caching and offline reading are
  a later plan once the online mobile experience is right.
- No geolocation ("events near me") in v1. The browser API is
  opt-in, but it is a product decision with privacy weight, and it is
  open question 38.
- No new data model, no new API, no new tables. The sheet reads the
  same `/api/data/locations` responses the popup reads; the timeline
  reads the same time-window query.

## Sequencing

After plans 30 (clustering and viewport fetching - the sheet replaces
the popup, so it lands once cluster behaviour is settled), 31 (share
links are the mobile entry point), 38 (detail pages the sheet links
to), 40 (the accessibility rules the sheet follows), and 41 (the
journey player the sheet hosts). Before any public launch or SEO push
plan 38 enables: a shared link that opens a broken mobile map is
worse than no link at all, and this is the pushback - mobile is not a
post-launch polish pass, it is the launch. Not a plan 26 pilot
blocker: the pilot validates ingestion, and the mobile UI only matters
once ingested events exist at volume. It can be built in parallel with
plan 30, but it ships after it.

## Acceptance criteria

- On a 390px viewport: one-finger pan, pinch zoom, and double-tap
  zoom all work; a two-finger rotate does nothing in v1.
- Tapping a pin opens the sheet at peek; dragging to half and full
  shows progressively more content; swipe-down or Escape closes it;
  the map stays pannable and zoomable behind the sheet at peek and
  half.
- Every control on the mobile map is at least 44pt on its smallest
  side; no feature is reachable only by hovering.
- Tapping a cluster zooms to its extent; no tooltip appears.
- The timeline scrubs by touch; fuzzy events keep their uncertain
  markers at small sizes.
- Playwright mobile-emulation specs (iPhone and Pixel viewports,
  touch tap) are green in the mocked suite. The e2e-real suite is red
  since Oct 19 and owned by plan 35: mobile specs land in the mocked
  suite first and are not gated on e2e-real going green.
- A plan 31 share link tapped on a phone lands on the event, in the
  sheet, at the right step for a journey link.
- No Splink anywhere in this plan's implementation or text: dedup
  remains blocking plus Jev pairwise judging per the 2026-10-23
  decision, and this plan touches no dedup code.
- The 44 curated events get no mobile-specific treatment: they are
  slated for deletion per the standing directive, and a mobile
  polish pass built on them would be a reason to keep them.

## Open questions (carried to the backlog as 36-38)

36. Pinch-rotate: disable in v1 to stop accidental rotation, or keep
    OpenLayers' default on?
37. Page-scroll: full-viewport map page on mobile, or an embedded map
    with two-finger pan / tap-to-enable?
38. Geolocation: an opt-in "events near me" button using browser
    geolocation in v1, or skip entirely for privacy and simplicity?
