# Temporal playback: play history forward on the map

**Related:** [00-README.md](./00-README.md) (phases 05-09), [25-product-backlog.md](./25-product-backlog.md) (product step #26), [26-wikidata-pilot.md](./26-wikidata-pilot.md) (global pilot, event volume), [30-map-ux-at-scale.md](./30-map-ux-at-scale.md) (clustering, viewport + time-window fetching), [31-shareable-map-state.md](./31-shareable-map-state.md) (share links, timeline window), [32-fuzzy-dates.md](./32-fuzzy-dates.md) (date model, uncertain markers), [34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md) (review queue), [38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (detail pages), [40-accessible-map-experience.md](./40-accessible-map-experience.md) (keyboard, reduced motion, aria-live), [41-sequence-journeys.md](./41-sequence-journeys.md) (curated journeys), [42-mobile-map-experience.md](./42-mobile-map-experience.md) (bottom sheet), [44-product-analytics-search-intelligence.md](./44-product-analytics-search-intelligence.md) (engagement), [46-event-selection-notability.md](./46-event-selection-notability.md) (significance bands).

**Changelog:**
- 2026-11-13 — First version. Fills the gap the map's timeline leaves: plan 30 gives the reader a timeline to scrub and a density-aware zoom, but nothing moves on its own — while every comparable that wins on engagement sells watching history happen, and the map's own event data (dates + places) is exactly the input playback needs.

## Why this plan exists

A static timeline answers "what happened in this window" and stops. The products readers remember let time run:

- **Chronograph** (Interactive Historical World Atlas, 610–2026) makes it a first-class verb: "Choose a year or start playback to follow changes over time."
- **Historiqly's Atlas** (3000 BC–today, 49 dated snapshots) lists timeline playback as a Plus feature — it is literally what they charge for.
- **Imperium** (deficodes.nl, 5000 BCE–2026, deck.gl) ships four playback speeds, Space to play/pause, arrow keys to step year by year, and a visual language for change: newly appeared territories flash gold for 600ms, disappearing ones flash dark-red through a ghost layer.
- **Age of Events** cross-fades 5,000 polities as you scrub, with capitals updating in real time — Rome → Milan → Ravenna → Constantinople plays out without the reader touching anything but the slider.
- **Animaps** animates borders year by year with a year counter and camera moves between segments, and exports the result as video — the extreme end of the same instinct.
- **ArcGIS Map Viewer** time sliders and **MapStore's Timeline** both treat play/pause, step forward/back, and configurable speed/intervals as the default controls for any time-aware layer, with MapStore snapping the cursor to the nearest time that actually has data.

The map already has the raw material: every published event has a plan 32 date (strict start/end bounds plus a display string) and a place. What no plan owns is the cursor — the moving "now" that decides which events are visible, how fast it moves, what happens when it reaches the edge of what is loaded, and how a reader who cannot see motion at all still follows along. Without this plan, one of three things happens: a coding agent bolts a `setInterval` onto plan 30's timeline and re-fetches on every frame; or playback is built as video export (Animaps' model) instead of an interactive map feature; or it ships with autoplay on, which plan 40's reduced-motion handling would have to undo after the fact.

## The playback model: a cursor, not a video

### 1. The cursor is a date; visibility is a rule, not a frame

- Playback state is a single cursor date plus a speed, held in the same store as plan 30's timeline window and plan 31's shareable state. The cursor advances; the map shows events whose plan 32 strict start is at or before the cursor and whose strict end is after the window's start (i.e. the event has begun by "now"). Events do not disappear as the cursor passes them — history accumulates — unless the reader has set a trailing window (see below).
- **Fuzzy dates follow plan 32, not a guess.** An event with an interval (circa, earliest/latest) appears when the cursor enters its interval, rendered with plan 32's distinct uncertain marker from the first frame. It is never held back to its midpoint and never presented as precisely dated.
- **Significance bands follow plan 46.** Minor-band events appear only when the reader's minor-events toggle is on, exactly as in the static view — playback does not quietly change the density policy. The cluster representative at low zoom is still the highest-band event (plan 46), so a dense century does not turn into a flashing pile.
- **Trailing window is an option, not the default.** Default playback is cumulative (everything up to the cursor stays visible). A "last N years" trailing window is a reader control for dense periods, and it is the only mode in which events leave the map as the cursor advances — faded out, never popped off.
- **New events announce themselves.** The Imperium pattern, adapted to pins: an event that appears on this frame gets a short entrance treatment (a 600ms pulse in the OpenLayers `postrender`/`vectorContext` style — the official custom-animation example's mechanism) and then settles to its normal pin. The pulse is a style change on already-loaded features, not a re-fetch. No sound, ever.

### 2. Speed is two knobs, and the reader picks the model

- **Years per second** is the honest default for a map whose promise is "the history that happened here": the cursor moves at a fixed rate through calendar time, so a quiet century takes as long as a busy decade and the reader feels the gaps. Speeds are a small fixed set (verify the set against the pilot's measured event density, do not invent numbers here — Imperium's slow/normal/fast/ultra is the shape, not the values).
- **Events per second** is the alternative for sparse data: the cursor jumps event-to-event at a fixed rate, so playback never stalls on an empty century. This is a mode, not a speed — the control says which model is running, and the year counter always shows the cursor date, so the reader is never misled about how much time just passed.
- **Step forward / back** moves the cursor to the next/previous event date in the loaded window (MapStore's snap-to-guide-layer pattern: the cursor snaps to a date that has data). Arrow keys do this when playback is paused (plan 40 keyboard model); Space toggles play/pause.
- **Scrubbing and playback are the same cursor.** Dragging plan 30's timeline slider moves the cursor; pressing play resumes from wherever the cursor sits. There is no separate "playback position" state to drift out of sync with the timeline.

### 3. Performance: animate styles, never re-fetch

- The hard lesson from the OpenLayers time-series work (dev.to, PMTiles multi-layer MVT): animating by switching sources or re-fetching per frame causes flicker and wasted CPU/GPU. The pattern that works is to load the data once and drive animation by re-evaluating styles on already-decoded features (`layer.changed()` on a mutable cursor variable).
- Playback therefore runs strictly inside the already-loaded window from plan 30's viewport + time-window fetching. The cursor advancing never triggers a fetch. When the cursor reaches the edge of the loaded window, playback **pauses** and the window fetch runs (plan 30's fetch, unchanged); playback resumes only when the reader presses play again, or when the fetch completes and the reader has chosen auto-continue (see open question 61). Never auto-fetch mid-playback and never silently extend the window while playing — a fetch stall mid-animation reads as a broken map.
- **Clusters recompute per frame, cheaply.** Plan 30's `ol/source/Cluster` re-clusters when the visible set changes; with playback the visible set changes every frame, so the cluster source must re-cluster on cursor movement without re-fetching features. If measured frame cost is too high at pilot volumes, the fallback is to re-cluster at most once per step (per event-appearance), not per animation frame — a measured decision, recorded in the plan 30 eval, not a guess here.
- **Prefetch the next window during a pause.** While paused (including the initial load), the client may prefetch the following time window in the background so a long playback run has fewer pauses. Prefetch is bounded by plan 43's read-surface limits and never runs while playing.

### 4. Accessibility: motion is opt-in, and the story works without it

- **Never autoplay.** Playback starts only from an explicit reader action. This is the plan 40 rule applied to the loudest motion on the page, and it is non-negotiable: autoplay would also fight plan 43's read-surface limits on shared links.
- **`prefers-reduced-motion` disables animation, not playback.** Under reduced motion the pins still appear as the cursor advances, but with no pulse and no smooth camera movement — playback becomes step-by-step jumps (cursor moves, pins appear, year updates). The feature remains usable; only the motion is removed. Plan 40 owns the detection; this plan consumes it.
- **The year is announced, not just shown.** The cursor date is a debounced `aria-live` summary (plan 40's pattern: one summary per settled view, not per frame) so a screen-reader user hears "1849 — 3 new events" at a sane rate, and the plan 40 semantic event list is the text equivalent of the playback: it lists the events visible at the cursor, in chronological order, and stays in sync with it.
- **Keyboard:** Space play/pause, Left/Right step event, Shift+Left/Right step year, Escape stops playback and returns focus to the timeline control. No keyboard trap; focus never leaves the control bar while playing.

## Surfaces

- **Map toolbar (plan 30) / bottom sheet (plan 42):** a compact transport bar — play/pause, step back, step forward, speed selector, mode toggle (years/sec vs events/sec), trailing-window toggle. On mobile it lives in the bottom sheet's header row (plan 42's 44pt targets apply to every transport button); on desktop it sits on the timeline. The year counter is large text next to the transport, always visible while playing.
- **Plan 31 share links:** a shared link carries the timeline window and may carry a playback start year (`t=<year>`), but never a playing state — a shared link always opens paused at its start year, so the recipient chooses to play. Playback speed and mode are reader preferences, not link state.
- **Plan 41 journeys:** playback and journeys are separate features that share the cursor. A journey step is a curated stop; playback is free-form time. The integration is one line in plan 41, not a feature here: when a journey is active, pressing play advances through the journey's steps instead of raw time (auto-advance with the same pause/step controls). If that integration is not built, playback with a journey active simply ignores the journey — it never hijacks it.
- **Plan 38 detail pages:** no playback on a detail page (a single event has no timeline to play). The detail page links back to the map at the event's date with the cursor set there, paused.
- **Plan 44 analytics:** playback start, completion (cursor reaches the window end), pause, and speed/mode choices are first-party events. The zero-result review does not apply here; instead the weekly review asks whether readers finish playbacks or abandon them mid-window, which is the signal for whether the default speed is wrong.

## What this plan does not do

- No video export (no MP4/GIF render, no Animaps-style studio). Playback is an interactive map feature; exporting it is a separate product decision with its own licensing and rendering costs.
- No border/polygon animation. The map's data is event pins; plan 29's OpenHistoricalMap boundary layer is a snapshot layer, and animating boundaries across snapshots is a later plan once the boundary layer exists and its snapshots are dated.
- No autoplay, no sound, no auto-advance of journeys in v1 (the journey integration above is a defined later step, not a silent default).
- Does not change plan 30's clustering, plan 32's date model, or plan 46's bands: playback consumes all three and adds no new rule to any of them.

## Sequencing

- After plans 30 (viewport + time-window fetching, clustering), 32 (date model), and 40 (keyboard, reduced motion, aria-live). The fetch and accessibility primitives must exist before playback is built on them.
- Before any public launch (plan 45): playback is the feature the paid comparables charge for, and launching without it means launching as a static catalogue. Not a plan 26 pilot blocker — the pilot measures event density, which sizes the speed set, but playback itself is display-side and can land after the pilot.
- Plan 43's read-surface limits bound prefetch; plan 44's analytics measure whether the default speed is right.

## Done when

- Play/pause, step forward/back (snapping to event dates), scrub, speed selector, and years/sec vs events/sec modes all work from one cursor shared with plan 30's timeline.
- Playback never triggers a fetch per frame; reaching the loaded window's edge pauses cleanly and resumes only on reader action (or per the auto-continue decision in open question 61).
- Fuzzy events appear at interval entry with plan 32's uncertain marker; minor-band events obey the plan 46 toggle.
- No autoplay ever; `prefers-reduced-motion` turns pulses and camera motion off while keeping playback usable; Space/arrows/Escape work; the year is announced via debounced aria-live and the plan 40 semantic list stays in sync.
- Shared links open paused at the start year; transport controls meet plan 42's 44pt targets on mobile.
- No Splink anywhere in this plan (dedup remains Jev pairwise judging per the 2026-10-23 decision).

## Open to James (see chat summary)

- Speed model: fixed years per second (honest about quiet centuries, can drag), or event-paced (constant events per second, never stalls but time jumps unevenly) — which is the default?
- End of the loaded window: pause and wait for the reader, or auto-fetch and keep playing?
- Journeys: when a journey is active, should play auto-advance through its steps, or should playback stay free-form and ignore the journey?
