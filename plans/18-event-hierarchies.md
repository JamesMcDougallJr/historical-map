# Event hierarchies: sequences and campaigns

**Status: design, not scheduled.** Recorded the same way `11-identity-and-fusion.md`
is — settling the shape of the problem before writing schema, so decisions made
under a real corpus don't get overwritten by decisions guessed in advance.

## The problem

Some historical events aren't atomic. The Mountain Meadows Massacre is really a
handful of sub-events — the initial attack, the siege, the parley, the killing,
the aftermath — at more than one location, over several days. Today those would
either become one event with a lossy single pin and a long description, or
several unrelated pins with no indication they're one story. Neither lets a
user query or filter down to "just this sequence."

## Relationship to fusion (`11-identity-and-fusion.md`)

Fusion and hierarchy are different axes and this doc assumes fusion resolves
first:

- **Fusion** asks "are these two records the *same* event?" (one document
  calling it `Overthrow of Tula`, another calling it `Rebellion that overthrew
  the Toltec government`) and collapses them to one canonical id.
- **Hierarchy** asks "are these *different* events part of one larger story?"
  and groups canonical ids without collapsing them.

A sequence member is always a post-fusion event id. If two documents describe
the same sub-event of a sequence, that's a fusion problem to solve first — the
group references whichever id fusion decided is canonical. This ordering means
the membership table below never needs to be rewritten when fusion logic
changes; it just points at different (better) ids over time.

## Sequences are meta events, not just a filter

The important framing shift from "a `HistoricalEvent` has a `groupId`" to
"a group is itself an event-like thing": a sequence has a title
("Mountain Meadows Massacre"), a description, and an implied date range and
rough geography — the same shape a `HistoricalEvent` has, but derived from its
members rather than authored directly. That's why it's modeled as a first-class
`EventGroup`, not a tag:

- It can be searched, linked to, and shown as a single result, the same way an
  event can.
- It can itself be a member of a larger group (a massacre inside a broader
  conflict), because nothing about "title + description + members" is
  specific to depth 0.
- Whether it *renders* as one pin or as a connected cluster of its members'
  pins is a rendering decision (below), not a schema one — the schema doesn't
  need to know.

## Many-to-many, not a parent pointer

`HistoricalEvent` does **not** get a single `parentGroupId`. Membership is
many-to-many:

- A skirmish can belong to both "the campaign" and "the broader war" — two
  narratives that overlap without one containing the other.
- Groups can nest (`EventGroup.parentGroupId`), so depth is unbounded, but an
  event's membership in multiple groups at the *same* level is normal, not an
  edge case to special-case around.

## Geographic proximity decides the rendering, not the schema

This is the resolved design point: **whether a sequence gets drawn as a
connected path/cluster depends on how tight its members' locations are, not on
any flag stored on the group.** A campaign whose sub-events happened within a
few km of each other (Mountain Meadows) reads naturally as a connected
sequence — numbered pins, a path between them, one bounding box to zoom to. A
"sequence" whose members are a continent apart (a war's opening and closing
battles) would just look like noise if forced into the same treatment — long
lines crossing unrelated pins, a zoom-to-fit that's useless at any scale.

Concretely: at render/query time, compute the bounding box (or a max
pairwise distance) of a group's member locations against a threshold. Below
it, `/map` draws the connective treatment (ordered path, shared highlight,
single zoom target). Above it, the group is available purely as a filter —
"show only this group's events" — with no attempt to visually relate them
beyond that. This keeps the threshold a tunable rendering constant, not a
decision an editor has to make by hand when creating a group, and it means the
same group automatically gets the right treatment if later sub-events change
its geographic spread.

Open question worth flagging rather than guessing: the actual threshold. Start
conservative (a few km, similar in spirit to the 1000m location-snap radius
already used in `findOrCreateLocation`) and adjust once there's more than one
real sequence in the corpus to look at — same "measure, don't guess" reasoning
as the fusion doc's date-bucket and merge-confidence questions.

## Sketch

`packages/domain/src/events.ts`:

```ts
export interface EventGroup {
  id: string;
  title: string;
  description?: string;
  parentGroupId?: string; // nesting; undefined = top-level
}
```

`HistoricalEvent` gains `groupIds?: string[]` for the JSON/localStorage tiers,
mirroring how `tags` already works there.

Postgres (`lib/postgres-storage.ts`):

```sql
CREATE TABLE event_groups (
  id              text PRIMARY KEY,
  title           text NOT NULL,
  description     text,
  parent_group_id text REFERENCES event_groups(id) ON DELETE SET NULL
);

CREATE TABLE event_group_members (
  group_id text NOT NULL REFERENCES event_groups(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seq      int  NOT NULL,  -- narrative order; independent of date, same
                            -- reasoning as fusion doc gap #3 (date can't be
                            -- identity/order because two sub-events can share
                            -- a date/precision)
  PRIMARY KEY (group_id, event_id)
);
CREATE INDEX event_group_members_event_idx ON event_group_members (event_id);
```

A group's derived bounding box/centroid/date-range is computed from members at
query time (join `event_group_members` → `events` → `locations`), not stored —
it must stay correct as membership changes, and it's cheap to compute given
the existing `locations_geom_idx` GIST index.

`app/map/utils/event-query.ts` (`EventQuery`): add `groupId?: string` and
`includeDescendants?: boolean` (walk `parent_group_id` when set). Both
backends implement it the way `sourceIds` works today — `server-storage.ts`
filters in memory over `data/map-data.json`, `postgres-storage.ts` joins
`event_group_members`.

## Surfaces

- **`/map`**: a group is a filterable dimension alongside timeline/source
  toggles. Selecting one narrows to its members; whether it also draws a
  path/cluster depends on the proximity check above.
- **MCP** (`mcp/register.ts`): `search_events` gains `groupId`; add
  `list_event_groups` and `get_event_group` (returns members ordered by
  `seq`, plus the derived bbox/date-range) so a sequence is navigable
  conversationally as well as spatially.
- **Ingestion** (`services/ingest`): out of scope for v1. Whether
  `extract-events` can propose groups from a single document describing a
  multi-part campaign is a real NLP question, but per the fusion doc's own
  "why not now" reasoning, there's currently one document in the corpus —
  any extraction heuristic here would be guessed, not measured. v1 is
  editor-curated groups only (an admin tool that assigns `groupIds`),
  same as `geocode:review` being a manual review step today.

## Open questions

1. **The proximity threshold** for connective rendering — needs a real
   multi-sequence corpus to tune, not a guess.
2. **`seq` density** — dense/contiguous integers vs. sparse (leaving room to
   insert), which matters once editors are reordering by hand rather than a
   script assigning them once.
3. **Depth limit on nesting** — probably none needed at the schema level, but
   `/map`'s filter UI needs *some* answer for how deep a nested picker goes
   before it's just a search box.
