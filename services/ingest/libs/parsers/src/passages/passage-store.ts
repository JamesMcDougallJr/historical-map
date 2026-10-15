/**
 * Writes `document_passages` and `passage_events` — the search index over
 * source documents' text (plans/20-search-lexical.md).
 *
 * Derived and disposable: every row here can be rebuilt from the stored text
 * artifact plus the map tables, with no network fetch. Object storage stays
 * the source of truth for text; this is an index of it.
 *
 * Plain SQL over a minimal `Queryable`, so a TypeORM DataSource, an
 * EntityManager inside a transaction, or a bare postgres client all work.
 */
import type { TextSegment } from "../document-parser.interface";
import { MIN_QUOTE_CHARS, normaliseQuote } from "./normalise-quote";
import { SPLITTER_VERSION, splitPassages } from "./split-passages";

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface TransactionalQueryable extends Queryable {
  transaction<T>(run: (manager: Queryable) => Promise<T>): Promise<T>;
}

/**
 * Replaces a document's passages with a fresh cut of `segments`, then
 * re-links its published events. Delete-then-insert in one transaction, so a
 * reader never sees a half-written document and a re-run is idempotent.
 */
export async function replacePassages(
  db: TransactionalQueryable,
  documentId: string,
  segments: TextSegment[],
  extractorVersion: number,
): Promise<number> {
  const passages = splitPassages(segments);
  await db.transaction(async (tx) => {
    await tx.query(`DELETE FROM document_passages WHERE document_id = $1`, [
      documentId,
    ]);
    // Batched: one statement per 200 rows keeps a 500-paragraph book to a
    // handful of round trips without hitting the bind-parameter limit.
    for (let i = 0; i < passages.length; i += 200) {
      const batch = passages.slice(i, i + 200);
      const values: string[] = [];
      const params: unknown[] = [];
      for (const p of batch) {
        const o = params.length;
        values.push(
          `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6}, $${o + 7}, $${o + 8})`,
        );
        params.push(
          documentId,
          p.seq,
          p.segmentAnchor,
          p.paraIndex,
          p.anchor,
          p.text,
          extractorVersion,
          SPLITTER_VERSION,
        );
      }
      await tx.query(
        `INSERT INTO document_passages
           (document_id, seq, segment_anchor, para_index, anchor, text,
            extractor_version, splitter_version)
         VALUES ${values.join(", ")}`,
        params,
      );
    }
    await relinkPassageEvents(tx, documentId);
  });
  return passages.length;
}

/**
 * Does this document need (re)indexing? True when it has no passages, or they
 * were cut by an older splitter or from an older cleaning of the text.
 */
export async function passagesStale(
  db: Queryable,
  documentId: string,
  extractorVersion: number,
): Promise<boolean> {
  const rows = (await db.query(
    `SELECT min(splitter_version) AS splitter, min(extractor_version) AS extractor,
            max(splitter_version) AS splitter_max, max(extractor_version) AS extractor_max
       FROM document_passages WHERE document_id = $1`,
    [documentId],
  )) as Array<{
    splitter: number | null;
    extractor: number | null;
    splitter_max: number | null;
    extractor_max: number | null;
  }>;
  const row = rows[0];
  if (!row || row.splitter === null) return true;
  return (
    row.splitter !== SPLITTER_VERSION ||
    row.splitter_max !== SPLITTER_VERSION ||
    row.extractor !== extractorVersion ||
    row.extractor_max !== extractorVersion
  );
}

interface PassageRow {
  seq: number;
  segment_anchor: string | null;
  text: string;
}

/**
 * Re-derives which published events were quoted from which paragraph, for
 * one document. Runs after `publish` writes events and after any re-split.
 *
 * For each event, look on its anchor page — plus the paragraph just before
 * that page's first, which may run across the page break into it — for the
 * paragraph containing its normalised quote. No paragraph contains it (the
 * model paraphrased, or the quote straddles a passage split) → no link; the
 * event still has its page anchor, so it degrades to page level rather than
 * guessing.
 */
export async function relinkPassageEvents(
  db: Queryable,
  documentId: string,
): Promise<number> {
  const passages = (await db.query(
    `SELECT seq, segment_anchor, text FROM document_passages
      WHERE document_id = $1 ORDER BY seq`,
    [documentId],
  )) as PassageRow[];
  const events = (await db.query(
    `SELECT id, anchor, source FROM events WHERE document_id = $1`,
    [documentId],
  )) as Array<{ id: string; anchor: string | null; source: string | null }>;

  await db.query(`DELETE FROM passage_events WHERE document_id = $1`, [
    documentId,
  ]);

  const normalised = passages.map((p) => normaliseQuote(p.text));
  let linked = 0;
  for (const event of events) {
    const quote = normaliseQuote(event.source ?? "");
    if (quote.length < MIN_QUOTE_CHARS) continue;

    const candidates: number[] = [];
    if (event.anchor) {
      const first = passages.findIndex(
        (p) => p.segment_anchor === event.anchor,
      );
      if (first > 0) candidates.push(first - 1);
      passages.forEach((p, i) => {
        if (p.segment_anchor === event.anchor) candidates.push(i);
      });
    } else {
      passages.forEach((_, i) => candidates.push(i));
    }

    const hit = candidates.find((i) => normalised[i]!.includes(quote));
    if (hit === undefined) continue;
    await db.query(
      `INSERT INTO passage_events (document_id, seq, event_id)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [documentId, passages[hit]!.seq, event.id],
    );
    linked++;
  }
  return linked;
}
