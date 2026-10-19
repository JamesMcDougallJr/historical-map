# Stretch B — Search on the MCP server

Part of [19-search.md](./19-search.md). **A stretch goal** (19, decision 7).
It depends on S1, and it can optionally use S3.

## What's there today

`mcp/register.ts` registers `search_events`, a text-only tool that calls
`storage.searchEvents(EventQuery)`. It is registered for **both** transports
(stdio with `writable: true`, and the read-only HTTP connector at `/api/mcp`).
Its `q` is the `ILIKE` matcher that S1 replaces, so **S1 already improves this
tool for free**: stemming, ranking, accents and dates. Nothing on the MCP
side needs to change for that.

What it can't do is return anything except events. Claude can't find a
sequence, a source passage or a place except by calling several `list_*`
tools and scanning the results itself.

## The tool

Add a `search` tool beside `search_events`. Don't replace it. Existing
conversations and prompts use `search_events`, and its structured filters are
still the right tool when Claude already knows the bbox and years.

```ts
server.tool(
  "search",
  {
    q: z.string().max(200).describe(
      "What to find. Names, places, dates ('1840s', '18th century') and quoted phrases all work."),
    kinds: z.array(z.enum(["event", "sequence", "location", "document", "passage"]))
      .optional().describe("Restrict result kinds. Default: all."),
    semantic: z.boolean().optional().describe(
      "Also match by meaning. Use for descriptions of an event rather than its name."),
    limit: z.number().int().max(25).optional(),
  },
  …
);
```

- **It calls the same core as `/api/search`**: a `lib/search.ts` function,
  not an HTTP hop to our own API, the same way `search_events` calls
  `storage` directly today. S1 should put the logic there from the start, so
  this tool is a thin wrapper rather than a refactor.
- **It returns `SearchHit[]` as JSON**, plus `modes` and `parsed`, so Claude
  can see that "1840s" became a date filter, or that semantic search was
  unavailable.
- **It's read-only, so it's safe on the public HTTP connector.** The reason
  `/api/mcp` excludes write tools doesn't apply.

## Showing results on the map

The MCP App renders `MapView` inline. Text results alone waste that. A hit
should be openable on the inline map:

- `show_map` gains optional `focus: { kind, id }`. The App flies to it and
  opens it, using the same imperative actions S2 adds (`flyTo`, `openPopup`,
  `focusGroup`, `filterToDocument`).
- **Limits of the sandbox:** the document panel's "Open original" link goes
  to a presigned S3/MinIO URL, which is an origin the iframe CSP doesn't
  allow (CLAUDE.md, "CSP is the thing that breaks the inline map"). Inside
  the App, passages and documents show their text and page only. The
  original-PDF link is a plain link Claude puts in its reply, not something
  the iframe fetches.
- Rebuilding `mcp/dist/mcp-app.html` (`npm run build:mcp`) is required after
  any of this. The bundle is an artifact.

## Semantic mode over MCP

Less valuable than on `/map`, because Claude already turns "the attack on the
emigrant wagon train" into keywords. But not useless: Claude can't guess
"Baker–Fancher" if it has never seen the corpus. Expose it as the opt-in
`semantic` flag above. It goes through the same rate limit and daily ceiling
as the web app (23). An MCP client is just another public caller.

## Static backend

The stdio server usually runs without `POSTGRES_URL`, against
`data/map-data.json`. There, `search` falls back to S1's in-memory scorer.
It returns events, sequences and locations, with `modes.documents = false` and
`modes.semantic = false`. Since the response says so, Claude can explain the
gap instead of reporting "no matches".

## E2E specs

### `e2e-real/specs/api/search-mcp.spec.ts`

Uses the same `connect()` helper as `sources-and-mcp.spec.ts`, which already
drives `/api/mcp` with the SDK's `StreamableHTTPClientTransport`. Over the **HTTP connector** (read-only,
public):

- `tools/list` includes `search`, and still includes `search_events`, which is
  unchanged. The existing "write tools are not reachable" test still passes,
  and `search` adds no write path.
- `search { q: "massacred" }` → JSON content whose hits include
  `fx-ev-massacre` with `kind: "event"`, plus `modes` and `parsed`. These are
  the same ids `/api/search` returns for the same query. Assert the two
  responses agree, which is the "one core, two callers" check.
- `kinds: ["sequence"]` returns only sequence hits.
- `q` longer than 200 characters → a schema validation error, not a crash.
- `semantic: true` with `EMBEDDING_ENGINE=fake` → `meaning` hits. With the
  fake set to fail → lexical with `modes.semantic = false`.
- It counts against the same hybrid rate limit as `/api/search`. Exhaust it
  via `/api/search`, then the MCP call degrades too.

### stdio check — `scripts/verify-mcp-search.ts`

A small script using `@modelcontextprotocol/sdk`'s stdio client against
`npm run mcp`, with no `POSTGRES_URL` (the JSON tier):

- `search { q: <a word from data/map-data.json> }` returns event hits.
- `modes.documents` and `modes.semantic` are both `false`.

It goes in CI after the real suite only if it stays under a few seconds.
Otherwise it's a manual `npm run mcp:verify`, like the ingest verifiers.

### `e2e/mcp-app-focus.spec.ts` — the inline map

**There is no MCP App test harness today**, so this spec builds one. Serve
the built `mcp/dist/mcp-app.html` from a tiny static route, embed it in a
test page acting as the host, and post the `show_map` tool result to the
iframe the way a host would, with `focus: { kind: "event", id }`. It's the
most expensive spec in the search track, so build it last and only if
Stretch B ships the `focus` parameter. Assert that the view centres on the event and the popup is pinned. For `focus` on a document,
the panel renders text and pages, and **no** element requests the presigned
original (assert no network request to the S3 origin). This is the CSP
constraint from CLAUDE.md, tested rather than assumed.
