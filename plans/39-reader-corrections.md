# Reader corrections: a public "report an error" flow that never edits the map directly

**Related:** [37-post-publish-lifecycle.md](./37-post-publish-lifecycle.md)
(plan 37 explicitly deferred a public "report an error" flow as a
separate product decision; this plan is that decision),
[38-event-detail-pages-seo.md](./38-event-detail-pages-seo.md) (the
detail page at `app/events/[slug]/page.tsx` is where a reader spots
the error and where the report form lives),
[34-pipeline-observability-review-queue.md](./34-pipeline-observability-review-queue.md)
(the `/admin/review` queue and `ingest_review_items` table this flow
feeds, not a new moderation system),
[32-fuzzy-dates.md](./32-fuzzy-dates.md) (date corrections re-run its
mapping), [36-geoparsing-place-disambiguation.md](./36-geoparsing-place-disambiguation.md)
(place corrections re-run its resolution),
[33-source-licensing-attribution.md](./33-source-licensing-attribution.md)
(what a correction may and may not put into an event record),
[31-shareable-map-state.md](./31-shareable-map-state.md) (the map popup
links to the detail page; it does not carry its own report form),
[25-product-backlog.md](./25-product-backlog.md) (step 15, open questions
27-29).

**Changelog:**
- 2026-11-02 - Created from the daily research loop. No plan owned
  the reader side of correction: plan 37 owns source-driven
  corrections and plan 34 owns the review queue, but a reader who
  knows a date or a pin is wrong currently has no way to say so
  except by finding James. This plan adds the intake, the triage,
  and the application rules, and deliberately adds no public editing.

## Why this plan exists

Published events will be wrong sometimes, and the pipeline cannot
catch every kind of wrong on its own:

- A source can be confidently, precisely wrong. Wikidata, a book
  extract, and a gazetteer can all agree on a date that local
  knowledge contradicts. No dedup judge (plan 13, Jev pairwise
  judging) and no geoparser confidence band (plan 36) fires when
  every source points the same wrong way.
- The people most likely to notice are readers, not the pipeline:
  someone who knows the town, the battle, the building. Every
  comparable map product that takes this seriously separates
  *reporting* from *editing*. OpenStreetMap lets anyone file a
  Note, anonymous included, and a mapper decides; Google Maps
  takes a "suggest an edit" and reviews it before anything
  changes. Neither lets a stranger rewrite the record on submit.
  This plan follows the same reviewed-suggestion model, because
  the reviewer here is one person (plan 34, open question 12:
  James-only for v1) and the corpus is historical claims, not
  business hours - a wrong approval is worse than a slow one.
- Plan 38 made the problem visible without solving it. A detail
  page gives a reader a stable URL to point at and quote, and a
  sitemap will send more such readers to individual events. A
  page that shows a wrong date with no way to challenge it is a
  dead end; a page with a report form turns every reader into a
  potential second pair of eyes.

This plan is deliberately narrow. It does not build accounts,
public discussion threads, a reputation system, or an edit
history for readers. It adds one intake, routed into the one
review queue that already exists, with application rules that
reuse plan 37's lifecycle instead of inventing a second one.

## The one rule, stated first

**A reader report never changes a published event.** It creates a
review item. Only a reviewer decision in `/admin/review` changes
anything, and that change goes through plan 37 (version row,
scoped re-publish, manual-override flag) exactly as a
source-driven correction does. There is no auto-publish path, no
vote threshold, no "three reports and it flips" rule. Volume is a
triage signal, never an approval.

## What a reader can report

One form, on the detail page, with a fixed category list. Free
text alone is not a category: the category decides which
application rule runs if the report is approved.

| Category | What the reader supplies | Approved, it becomes |
| -------- | ------------------------ | -------------------- |
| Wrong date | The corrected date (or date range), in plain text | A plan 32 re-mapping: precision, circa / presumably / disputed flags, earliest / latest bounds, EDTF string, strict bounds. Timeline spans (plan 30) move with the new bounds. |
| Wrong place or pin | The corrected place name, and optionally a corrected pin the reader drops on a small map | A plan 36 re-resolution for that event only. The old pin stays in the version history. |
| Wrong title or description | Which field, and what is wrong with it | A reviewer-written field correction (see "Submitter prose is never published" below). |
| Duplicate of another event | The other event's URL or slug | A plan 37 merge, with its no-automatic-remerge guard if the pair was ever split. |
| Missing event | A source link for the missing event (required, not optional) | A suggestion review item, not a new event. The reviewer may turn it into a source-adapter request; it never auto-ingests. |
| Inappropriate content | What is wrong, and why | A review item only. Nothing is auto-removed: removal of a published event is a plan 37 tombstone decision, made by the reviewer, not by the report. |
| Other | A note | A review item, decided on its evidence like any other. |

Fields on every report: category (required), the corrected value
where the category has one (a short text field, capped, not a
rich-text editor), evidence links (up to 3 URLs: a source page,
a book reference, a gazetteer entry), and a note (capped at
1,000 characters, plain text). Contact email is optional, for
follow-up questions only: it is never displayed, never put in
an event record, and never used for marketing or decision
notices in v1 (see open question 28).

What the form must not invite: pasted source text. Evidence is a
link, not a quotation. That keeps plan 28's link-only discipline
general: a reader pasting a Britannica paragraph, a book passage,
or a Wikipedia article into a note would put copyrighted or
share-alike text into the review store, and plan 33's publish
gate exists precisely to keep undeclared text out of event
records. The form says so in one line next to the evidence
field ("Link to the source; do not paste its text"), and the
server rejects notes over the length cap rather than truncating
silently.

## Submission: low barrier, no account, no public surface

V1 takes the OpenStreetMap Notes bargain: anyone can report,
including anonymously, because requiring an account would kill
most corrections from the exact readers who know something,
and the reviewer, not the submitter, is the trust boundary.
That bargain only works with the abuse controls below, and with
the rule that nothing submitted is ever public.

- **No separate report URL.** The form is a section of the
  detail page (`app/events/[slug]/page.tsx`), posting to
  `app/api/events/[slug]/reports/route.ts`. There is no
  `/events/<slug>/report` page to index, no report in the plan
  38 sitemap, and no report content in search results. Reports
  are private correspondence with the reviewer, not user
  content on the site. (Unreviewed user submissions staying out
  of search is also the safe default for the site's own
  indexing: nothing unmoderated earns a URL.)
- **No login in v1.** No account system is built for this.
  Open question 27 asks whether that stays true; the cost of
  switching later is a submitter-identity column, not a
  redesign, because reports are already keyed to the event,
  not to a user.
- **Thank-you, not a tracking page.** After submit, the reader
  sees what happens next in plain language: a human reviews
  every report, approved corrections appear on the event page,
  nothing changes until then, and there is no promised
  turnaround time until report volume is known. No receipt
  token, no public status lookup: a status page would expose
  the review queue's contents and backlog to anyone with a
  token, and v1 has no reason to build that surface.
- **Curated-seed events are reportable too.** A report on one
  of the 44 curated events (standing directive: slated for
  deletion once plan 26 validates) lands in the queue flagged
  as a seed event, so the reviewer can fix it or let
  retirement supersede it. Reporting is not disabled for
  seed pages: a reader cannot be expected to know which rows
  are temporary.

## Abuse controls: cheap, server-side, and honest about their limits

The threat model is low-volume spam and drive-by abuse, not a
determined adversary. The controls are proportionate to that,
and each one is server-side: anything enforced only in the
browser is decoration.

- **Honeypot field.** A field humans never see; a submission
  that fills it is discarded. This catches naive bots at zero
  cost to real readers.
- **Rate limits.** Starting values, to be tuned against real
  volume, not gospel: 5 reports per hour and 20 per day per
  hashed IP address. Raw IP addresses are not stored
  long-term; the hash exists for the rate window only.
- **Shape limits.** Length caps on every field, at most 3
  evidence links, no HTML in any field (stored and rendered
  as plain text in the admin UI). A report that is mostly
  links, or that repeats the same link across many events in
  a short window, is flagged for the reviewer rather than
  silently dropped, so a genuine reader citing one source
  repeatedly is not mistaken for a bot.
- **No CAPTCHA in v1.** A CAPTCHA taxes every genuine reader
  for a problem the site does not yet have. If the spam rate
  crosses the alert threshold below, adding one is a
  single-form change, and the plan 34 alert channel is where
  that decision gets made - not a redesign.
- **No auto-response email.** The optional contact address is
  never mailed a confirmation, so a report cannot be used to
  bounce mail at someone else's address.

What these controls do not do: they do not verify that a
reporter is who they claim to be, and they do not stop a
determined person submitting one careful false report. That
is what the reviewer is for. The controls keep the queue
human-sized; the reviewer keeps it honest.

## Storage: a raw report table, plus one review item per distinct correction

Two tables, because raw submissions and review decisions have
different lifecycles:

- **`reader_reports`** (new, Postgres, alongside the existing
  tables). One row per submission: `event_id` (the published
  event's internal id; the slug is resolved at submit time so
  a later slug change does not orphan the report),
  `category`, `proposed_value`, `evidence_links`,
  `note`, `contact_email` (nullable, encrypted at rest if the
  app already encrypts comparable fields, otherwise plain
  with access limited to the admin API),
  `submitted_at`, `ip_hash` (rate-limiting only),
  `decision` (mirrored from the review item for reporting,
  never the source of truth for the map).
- **`ingest_review_items`** (plan 34, reused). One row per
  *distinct* correction, linked to its reports. The review
  item's `proposed_payload` is the reviewer-facing correction
  (current values beside proposed values, source anchors from
  plan 14 for the current event, flagged fields highlighted
  per plan 34), not the raw submission. The review item
  carries a new reason value, `READER_CORRECTION`, plus the
  category in a dedicated column so the queue can filter and
  batch by it (batch review by reason is already a plan 34
  v1 feature, and reader reports will cluster by cause the
  same way pipeline flags do).

**Dedup of reports, before they reach the reviewer as work:**

- Same event, same category, same normalized proposed value,
  while a review item for it is still pending: the new report
  is attached to that item (report count +1, new evidence
  links appended, capped), and no second item is created.
  Ten readers agreeing on the same corrected date is one
  decision, with a count that tells the reviewer it is
  corroborated - not ten decisions.
- Same correction after a rejection, with no new evidence:
  closed as a duplicate of the prior decision, visible in
  the admin UI as a duplicate count, not as new work. A
  re-report that *does* add a new evidence link reopens a
  fresh review item: a rejected correction can be right on
  the second attempt, and "rejected once" must never become
  "rejected forever."
- Same event, different category or different proposed value:
  a separate item. A wrong date and a wrong pin on the same
  event are two decisions, and approving one must not
  implicitly approve the other.

**Retention.** The decision record is kept (it is the audit
trail for why the map changed). Contact emails are purged
90 days after decision; IP hashes after 30 days. Raw notes
are kept with the decision record: they explain the change,
and they are admin-only, never published.

## Review and application: the reviewer decides, plan 37 applies

The review UI is plan 34's `/admin/review`, extended by one
filter (reader corrections) and one view, not a second admin
tool. Per item the reviewer sees: the published event as it
stands (title, date display per plan 32, place and pin per
plan 36, sources per plan 33), the proposed correction, the
evidence links, the report count and any attached notes, and
the plan 14 source anchors for the current values, so the
judgement is evidence against evidence, not a vote count.

Actions, all single-use with plan 34's approve-fingerprint
semantics (once decided, an item cannot be decided again;
if the payload changed after approval, publish refuses and
re-queues):

- **Approve.** The correction applies through plan 37's
  change class for the field: date corrections re-run plan
  32, place corrections re-run plan 36, merges run plan 37's
  merge procedure, and every applied correction writes a
  plan 37 version row and sets the plan 37 manual-override
  flag on the corrected fields. That flag is the whole point
  of routing through plan 37: a later source re-publish that
  touches an overridden field conflicts and routes back to
  review with both values side by side, instead of silently
  overwriting a human decision.
- **Approve with edits.** The reviewer corrects the proposed
  value (a reader's date is close but the precision is wrong,
  a pin is a street off) and approves the edited version.
  The fingerprint covers the edited payload, so what was
  approved is what gets written.
- **Reject.** With a reason, chosen from: insufficient
  evidence, contradicted by a cited source, duplicate of an
  earlier decision, or out of scope (for example, a missing
  event with no source link). The reason is stored on the
  review item and drives the duplicate rule above.
- **Ask for more information.** Only when a contact email was
  given: one reviewer email asking for the missing source.
  Without a contact address there is nobody to ask, so the
  item is decided on the evidence present (usually
  reject-insufficient-evidence) rather than left pending.
  There is no public comment thread on a report in v1: a
  two-way thread is a product in itself (notifications,
  moderation of the thread, identity), and the single email
  covers the case that actually needs a follow-up. Open
  question 28 asks whether that stays true.

**Submitter prose is never published.** If a reader proposes
a corrected description, the reviewer does not paste the
reader's words into the event. The reviewer rewrites the
field from the cited source, in the pipeline's own factual
style, or approves only the factual claim (date, place,
name) and leaves the description to the source text. This
keeps plan 33's licensing story intact: the event record
contains sourced facts and pipeline text, not unlicensed
user prose, and a malicious or promotional sentence can
never ride a correction onto the map. The same rule covers
notes: a note explains a correction to the reviewer; it is
never event content.

## What this plan does not do

- **No public editing, no accounts, no reputation.** A
  trusted-reader fast lane (auto-approve after N accepted
  corrections) is explicitly deferred: it needs identity,
  and identity is the thing v1 declined to build. If report
  volume ever justifies it, it is a separate plan, and its
  first question is open question 27.
- **No discussion threads, no public status pages, no
  decision emails in v1.** See open question 28.
- **No missing-event ingestion.** A missing-event report is
  a suggestion, not a document. Turning suggestions into
  ingested events means a source adapter (plan 05) or a
  manual entry through `/map/import`, not a shortcut around
  either. Open question 29 asks whether suggestions are
  even in v1 scope.
- **No legal takedown workflow.** Plan 37 already excludes
  it; a compelled removal is its own plan if it ever arises.
  An "inappropriate content" report about a historical event
  is a correction decision, not a takedown.
- **No change to the published event's slug.** A corrected
  title does not regenerate the plan 38 slug, and a corrected
  date does not either: slugs are stable once assigned, and
  plan 38's slug history already handles the redirects if a
  slug ever does change for another reason.

## Metrics and alerts (into plan 34's alert channel)

- Reports per week, by category; approval rate by category;
  median review age for reader items (plan 34's TTL watchdog
  already escalates stalled items - reader items get the same
  watchdog, not a second one).
- Duplicate rate: the share of reports that attach to an
  existing pending item. A rising duplicate rate means one
  visible error is generating many reports; fixing the
  error, not triaging faster, is the response.
- Spam rate: the share of reports discarded by honeypot or
  rate limit. Crossing a threshold (starting value: 25% of
  submissions in a week) triggers the CAPTCHA decision, not
  an automatic CAPTCHA.
- Manual-override conflicts per week involving a
  reader-corrected field (plan 37's metric, cut by origin):
  a rising count means sources and readers disagree
  systematically, which is a source-quality question, not a
  queue question.

## Done when

- A reader can file a report from a plan 38 detail page for
  each category above, anonymously, with evidence links and
  an optional contact email, and sees the thank-you text.
  No report changes a published event, creates a public URL,
  or appears in the sitemap.
- Reports land in `reader_reports`, dedup into one
  `ingest_review_items` row per distinct correction with
  reason `READER_CORRECTION`, and are reviewable in
  `/admin/review` with current values, proposed values,
  evidence links, and source anchors side by side.
- Approve writes a plan 37 version row, sets the
  manual-override flag on corrected fields, and re-runs only
  the scoped mapping (plan 32 for dates, plan 36 for
  places); a later source re-publish conflicting with an
  override routes to review instead of overwriting it.
- Reject with each reason above behaves as specified,
  including duplicate handling for re-reports with and
  without new evidence.
- Abuse controls behave as specified under test: honeypot
  submission discarded, rate limit enforced server-side,
  over-long notes rejected (not truncated), HTML stored as
  plain text.
- New specs land in the mocked E2E suite first. The
  real-backend suite stays gated on plan 35 going green,
  as plan 30's gate already requires.

## Open to James (see chat summary)

- Anonymous reports (OpenStreetMap Notes style) for v1, or
  require sign-in from the start?
- One-shot reports with a single follow-up email at most,
  or a two-way thread and decision emails when a contact
  address is given?
- Missing-event suggestions in v1 scope, or
  corrections-only, with suggestions deferred?
