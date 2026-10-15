// The search query log (plans/23-search-semantic.md, "Query log"): the
// ranking-evaluation record a golden set is grown from.
//
// It holds only what evaluation needs. No IP, no user agent, no session id —
// without one, logged queries can't be stitched into a person's history.
// Only submitted searches are logged (the client sends `log=1` on Enter),
// never typeahead keystrokes: an abandoned half-typed query is the most
// personal thing a search box sees. Rows live 90 days.

import type { SearchRequest } from "./search";
import { normaliseQuery } from "./search-semantic";
import { sqlClient } from "./postgres-storage";

const RETENTION_DAYS = 90;

let schemaReady: Promise<void> | null = null;

function ensureLogSchema(): Promise<void> {
  schemaReady ??= (async () => {
    await sqlClient()`
      CREATE TABLE IF NOT EXISTS search_query_log (
        id         bigserial PRIMARY KEY,
        q_norm     text NOT NULL,
        mode       text NOT NULL,
        filters    jsonb,
        hit_count  int  NOT NULL,
        clicked    text,
        ms         int  NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`;
  })().catch((error: unknown) => {
    schemaReady = null;
    throw error;
  });
  return schemaReady;
}

/** One row for a submitted search; its id goes back in the response for the click. */
export async function logSearch(
  req: SearchRequest,
  hitCount: number,
  ms: number,
): Promise<number | null> {
  try {
    await ensureLogSchema();
    const filters = {
      timeline: req.timeline
        ? req.timeline.map((y) => (Number.isFinite(y) ? y : null))
        : null,
      limitToView: Boolean(req.bbox || req.sourceIds?.length),
      kinds: req.kinds,
    };
    const [row] = await sqlClient()<{ id: string }[]>`
      INSERT INTO search_query_log (q_norm, mode, filters, hit_count, ms)
      VALUES (${normaliseQuery(req.q)}, ${req.mode}, ${sqlClient().json(filters)},
              ${hitCount}, ${Math.round(ms)})
      RETURNING id`;
    // Retention, swept on write — the table is small and nothing schedules it.
    await sweepSearchLog();
    return row ? Number(row.id) : null;
  } catch (error) {
    // The log is for evaluation; it never fails a search.
    console.warn(
      `[search] query log write failed: ${(error as Error)?.message}`,
    );
    return null;
  }
}

/** `clicked` is `kind:id` of the result the user opened. */
export async function logClick(id: number, clicked: string): Promise<boolean> {
  await ensureLogSchema();
  const rows = await sqlClient()`
    UPDATE search_query_log SET clicked = ${clicked.slice(0, 300)}
    WHERE id = ${id}
    RETURNING id`;
  return rows.length > 0;
}

export async function sweepSearchLog(): Promise<void> {
  await ensureLogSchema();
  await sqlClient()`
    DELETE FROM search_query_log
    WHERE created_at < now() - make_interval(days => ${RETENTION_DAYS})`;
}
