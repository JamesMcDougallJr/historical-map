# Sequence journeys: guided tours through event groups

**Related:** [PR #12](https://github.com/JamesMcDougallJr/historical-map/pull/12)
(auto-populate event sequences from extraction; `event_groups` /
`event_group_members`, the `/map` popup `MapPopup` / `EventCard` "Part of:
<sequence>" line, `/api/data/groups` and `/api/data/locations` - the data
this plan reads, and the reason it cannot ship before that PR merges),
[30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (clustering, viewport +
time-window fetching - journey mode temporarily overrides both),
[31-shareable-map-state.md](./31-shareable-map-state.md) (the journey is
plain map state: `sequence` + `step` query params, so a journey link is a
share link),
[32-fuzzy-dates.md](./32-fuzzy-dates.md) (step order uses the EDTF start
bound; uncertain steps keep their uncertain markers),
[33-source-licensing-attribution.md](./33-source-licensing-attribution.md)
(each step carries its own Sources line; a journey never blends
attributions),
[37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md) (a step
whose event was merged or tombstoned degrades, it does not break the
journey),
[38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (every step
leads to its detail page; the detail page's group line leads back into
the journey),
[40-accessible-map-experience.md](./40-accessible-map-experience.md) (the
semantic event list is the journey player for keyboard and
screen-reader users; motion follows its prefers-reduced-motion rule),
[25-product-backlog.md](./25-product-backlog.md) (step 17, open questions
33-35).

**Changelog:**
- 2026-11-04 - Created from the daily research loop. No plan owned the
  reader side of *following* a sequence: PR #12 builds the groups and
  the popup names them, but a reader who clicks "Part of: Donner Party
  Trek and Tragedy" today gets a label, not a journey. The pins stay
  isolated points. This plan turns a group into a guided tour - one
  step at a time, in order, on the same map - and deliberately adds no
  authoring tool, no routing engine, and no new data model to do it.

## Why this plan exists

A historical map answers "what happened here". A sequence answers "what
happened next, and where did it go". The two are different products,
and the repo already has the second one's data: PR #12's extraction
pass identifies narrative sequences across a document's events
(Donner Party Trek and Tragedy, Reed's Relief Expedition, Subsequent
Rescue Parties) and persists them as groups with members. What it
does not have is any way to walk one.

The comparable products all converged on the same shape, and this plan
copies it rather than inventing one:

- ArcGIS StoryMaps' Guided Tour takes a small curated set of places
  and walks the reader through them one point at a time, centring the
  map on each stop as the tour progresses, in either a map-focused
  layout (map fills the frame, text floats by) or a media-focused
  layout. It caps a tour at 30 stops, and offers an Explorer layout
  for readers who want to choose their own path instead of following
  one.
- Knight Lab's StoryMapJS is the same idea stripped down: a slide
  deck where each slide is a place, the map pans and zooms to it, and
  the route between stops is a dotted line whose most recent leg is
  highlighted and earlier legs are greyed out. Its own guidance is to
  keep a story to no more than 20 slides.
- The lesson from both: a journey is a *linear reading mode over
  existing pins*, not a second map, and the route line is a reading
  aid, not a claim about how anyone travelled.

## What ships

### 1. Journey mode is a state of `/map`, not a new page

Entering a journey does not navigate away. The popup's "Part of:
<sequence>" line and the plan 38 detail page's group line both become
links to `/map?sequence=<groupId>&step=0`, and plan 31's shareable
state gains exactly two params: `sequence` and `step`. Exiting the
journey (an explicit Exit control, or clearing the params) restores
the viewport and timeline window the reader had before entering.

No standalone sequences index page ships in v1: entry is always via
an event that belongs to a group. That is a deliberate constraint,
not an oversight - it keeps v1 to one new UI surface, and it is open
question 33.

### 2. The player: steps, order, progress

The journey panel lists the group's members in order, one entry per
step, with the current step highlighted and a "Step 3 of 12" counter
plus Prev / Next controls. Order is derived, never edited in v1:

1. Chronological by the plan 32 EDTF start bound.
2. Ties break by the group's member order as PR #12 persisted it
   (the extraction's narrative order), never by pin position.
3. Steps with uncertain dates keep their plan 32 uncertain markers
   in the list; uncertainty never reorders a step silently.

The timeline window follows the current step (plan 30's time-window
query, narrowed to the step's date or span) while the journey is
active, and is restored on exit. The reader can still drag the
timeline mid-journey; doing so pauses journey-driven window changes
until the next explicit step change, so the map never fights the
reader.

### 3. Map behaviour per step

On a step change, the map centres on that step's pin with an
OpenLayers `View.animate` pan/zoom (the same view animation
primitive OpenLayers documents for animated pan, zoom, and
rotation), unless the reader has `prefers-reduced-motion` set, in
which case plan 40's rule applies and the view jumps instantly with
no animation. Non-journey pins dim; the current step's pin is
numbered, matching its number in the step list, so list and map
agree at a glance.

Stops are connected by a dashed order line in step order, drawn
from the StoryMapJS pattern: the leg just travelled is highlighted,
earlier legs are greyed. The line is labelled in the UI, plainly,
as sequence order - "stops in order, not a travelled route". No
routing API is called, no path is smoothed or snapped to roads, and
no line is drawn that a source does not support: if the group's
events are thematically linked but not a physical journey, the line
still only claims order, and open question 34 asks whether even
that is too much.

Plan 30's clustering is suspended inside journey mode: every stop
gets its own numbered pin, even at a zoom where the main map would
cluster them. Two stops at the same coordinates stack as a numbered
cluster that expands to its steps in the list, rather than hiding
one behind the other.

### 4. Steps without a pin, and steps that moved

A group member with no resolved coordinates (plan 36's abstain path,
or a list-only unresolved event per backlog open question 20) still
appears as a step in the list, marked "no location". Selecting it
shows the step and its detail-page link but moves no map, and Next
skips ahead to the next located step. A journey never drops a step
silently because it has no pin.

A step whose event was merged or tombstoned after the journey link
was shared (plan 37) renders as a degraded step: "This event was
merged" with a link to the successor (plan 38's one-hop 301 logic,
applied at UI level), or "This event was removed" for a tombstone,
and the journey continues past it. The step count does not change
under the reader; the degraded step still occupies its number.

### 5. Accessibility is the same player, not a second one

Plan 40's semantic event list *is* the journey player for keyboard
and screen-reader users: the step list is a real list, Prev / Next
are buttons, the current step is announced once per step change
through the same debounced aria-live summary plan 40 already
specifies (which also bears on backlog open question 32), and
Escape exits journey mode and returns focus to the control that
entered it. There is no separate accessible journey; a journey
that only works with a mouse is not done.

## What this plan does not do

- No sequence authoring or reordering UI. Groups come from PR #12's
  extraction pass; a human-edited group order is a later plan, and
  it goes through plan 34's review queue if it ever exists.
- No narration, audio, or video per step. A step's media is
  whatever its plan 38 detail page already has.
- No routing, directions, or travelled-path reconstruction. The
  dashed line is order only (see section 3 and open question 34).
- No user-created tours, no tour search, no "journeys near me".
  Discovery in v1 is: you found an event, it belongs to a group,
  you follow the group.
- No new tables. Journey mode reads `event_groups` /
  `event_group_members` through the existing `/api/data/groups`
  and `/api/data/locations` responses; if those endpoints cannot
  serve a whole group in one response, that is a PR #12 follow-up,
  not a new API in this plan.

## Sequencing

After PR #12 merges (hard prerequisite - without it there are no
groups to tour), after plan 38's detail pages (steps link to them),
reusing plan 40's list and motion rules. Not a plan 26 pilot
blocker: the pilot validates ingestion, and journeys are a reader
feature that only matters once ingested groups exist at volume.
Before any public launch or SEO push plan 38 enables, journeys
should exist for at least the groups the pilot produces, or the
"Part of" line is a dead end.

## Acceptance criteria

- From any event popup or detail page, one click enters journey
  mode for that event's group, at that event's step, with the map
  centred on it.
- Prev / Next, the step counter, and the numbered pins stay in
  sync through a whole group, including a group with same-location
  stops and a group with an unlocated step.
- Sharing a `/map?sequence=<id>&step=<n>` link lands a second
  reader on the same step; a step whose event was merged or
  tombstoned renders degraded, never blank or broken.
- The dashed order line is labelled as order, not a route, and no
  routing API is called.
- The full journey is usable from the keyboard alone, with
  `prefers-reduced-motion` producing instant view changes, and
  the step list is the text equivalent plan 40 requires.
- No Splink anywhere in this plan's implementation or text: dedup
  remains blocking plus Jev pairwise judging per the 2026-10-23
  decision, and this plan touches no dedup code.
- The 44 curated events are not given a journey of their own:
  they are slated for deletion per the standing directive, and a
  journey built on them would be a reason to keep them.

## Open questions (carried to the backlog as 33-35)

33. Journey entry: popup and detail-page links only in v1, or a
    browse-all-sequences index page too?
34. Route line: dashed order line labelled "not a travelled
    route", or no line at all (numbered pins only) to avoid
    implying a path?
35. Long groups: cap journeys at 30 steps like ArcGIS StoryMaps'
    Guided Tour, follow StoryMapJS's advice to stay near 20, or
    support any length with a scrolling step list?
