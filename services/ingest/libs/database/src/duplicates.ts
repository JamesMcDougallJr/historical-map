import type { DuplicateItem } from "@historical-map/domain";

/**
 * Reads and resolves the events `publish` set aside as duplicates of ones already
 * on the map. One implementation behind both `npm run duplicate:review` and the
 * admin panel, so the two cannot drift.
 *
 * Takes a bare `query` function rather than a TypeORM `DataSource` so the CLI,
 * the API and tests can all hand it whatever they have.
 */
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

/** Name `apps/workers/publish/src/publishing/jev-dedup.ts` records the decision under. */
export const DUPLICATE_CHECK = "duplicate-published";

interface Row {
  event_key: string;
  document_id: string;
  event: DuplicateItem["event"];
  checks: Array<{
    name: string;
    passed: boolean;
    detail?: string;
    data?: { auto?: boolean; matchedEventId?: string; pSame?: number; pDistinct?: number };
  }>;
  resolved_at: string | null;
  created_at: string;
}

const FAILED = JSON.stringify([{ name: DUPLICATE_CHECK, passed: false }]);
const AUTO = JSON.stringify([{ name: DUPLICATE_CHECK, data: { auto: true } }]);

/**
 * Held (unresolved) and auto-resolved items, newest first. A candidate that a
 * person has approved or dismissed is in neither list.
 */
export async function listDuplicates(db: Queryable): Promise<DuplicateItem[]> {
  const rows = (await db.query(
    `SELECT event_key, document_id, event, checks, resolved_at, created_at
       FROM ingest_event_candidates
      WHERE verdict = 'review'
        AND checks @> $1::jsonb
        AND (resolved_at IS NULL OR checks @> $2::jsonb)
      ORDER BY created_at DESC`,
    [FAILED, AUTO],
  )) as Row[];

  const matchIds = rows
    .map((r) => r.checks.find((c) => c.name === DUPLICATE_CHECK)?.data?.matchedEventId)
    .filter((id): id is string => typeof id === "string");
  const matches = new Map<string, NonNullable<DuplicateItem["match"]>>();
  if (matchIds.length > 0) {
    const found = (await db.query(
      `SELECT e.id, e.title, to_char(e.date, 'YYYY-MM-DD') AS date,
              e.date_text AS "dateText", l.name AS "placeName",
              e.source_id AS "sourceId", e.description, e.source AS quote
         FROM events e JOIN locations l ON l.id = e.location_id
        WHERE e.id = ANY($1)`,
      [matchIds],
    )) as Array<NonNullable<DuplicateItem["match"]>>;
    for (const m of found) matches.set(m.id, m);
  }

  return rows.map((r) => {
    const check = r.checks.find((c) => c.name === DUPLICATE_CHECK);
    const matchedId = check?.data?.matchedEventId;
    return {
      eventKey: r.event_key,
      documentId: r.document_id,
      status: r.resolved_at ? "auto-resolved" : "held",
      event: r.event,
      pSame: check?.data?.pSame ?? null,
      pDistinct: check?.data?.pDistinct ?? null,
      detail: check?.detail ?? "",
      match: (matchedId && matches.get(matchedId)) || null,
      createdAt: new Date(r.created_at).toISOString(),
    };
  });
}

export type DuplicateAction = "approve" | "dismiss";

export type ResolveResult =
  | { ok: true; documentId: string; title: string }
  | { ok: false; reason: string };

/**
 * `approve`: "a different event — publish it." Also overturns an auto-resolved
 * duplicate. Marks the candidate publishable and resolved, then asks the caller to
 * re-queue the document's publish job (the queue lives with the caller).
 *
 * `dismiss`: "a duplicate — leave it out." Marks a held candidate resolved while it
 * stays in review. An auto-resolved one is already resolved, so there is nothing to
 * do and it is refused rather than silently succeeding.
 *
 * `validate`'s candidate upsert is `WHERE resolved_at IS NULL`, so re-validating
 * cannot undo either decision.
 */
export async function resolveDuplicate(
  db: Queryable,
  eventKey: string,
  action: DuplicateAction,
  requeuePublish: (documentId: string) => Promise<void>,
): Promise<ResolveResult> {
  const found = (await db.query(
    `SELECT event_key, document_id, event, checks, resolved_at
       FROM ingest_event_candidates
      WHERE event_key = $1
        AND verdict = 'review'
        AND checks @> $2::jsonb
        AND (resolved_at IS NULL OR checks @> $3::jsonb)`,
    [eventKey, FAILED, AUTO],
  )) as Row[];
  const row = found[0];
  if (!row) {
    return {
      ok: false,
      reason: `No held or auto-resolved duplicate with event key "${eventKey}".`,
    };
  }

  if (action === "dismiss") {
    if (row.resolved_at) {
      return { ok: false, reason: "Already resolved as a duplicate; nothing to dismiss." };
    }
    await db.query(
      `UPDATE ingest_event_candidates SET resolved_at = now() WHERE event_key = $1`,
      [eventKey],
    );
    return { ok: true, documentId: row.document_id, title: row.event.title };
  }

  await db.query(
    `UPDATE ingest_event_candidates
        SET verdict = 'publish', resolved_at = now()
      WHERE event_key = $1`,
    [eventKey],
  );
  await requeuePublish(row.document_id);
  return { ok: true, documentId: row.document_id, title: row.event.title };
}
