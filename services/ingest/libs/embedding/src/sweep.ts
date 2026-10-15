import type { DatePrecision } from "@historical-map/domain";
import { composeEventText, composeGroupText, contentHash } from "./compose";
import type { EmbeddingEngine } from "./embedding-engine.interface";

/** Anything with TypeORM's `query(sql, params)` — a DataSource or QueryRunner. */
export interface SqlRunner {
  query(sql: string, params?: unknown[]): Promise<unknown>;
}

export interface SweepCounts {
  checked: number;
  embedded: number;
}

/**
 * Limits a pass to some rows — for the ingestion fixture, which shares its
 * database with e2e-real's rows in CI and must embed only its own. Omitted
 * means everything, which is what the worker does.
 */
export interface SweepScope {
  eventSourceIds?: string[];
  groupIds?: string[];
  /** `ingest_sources.key` of the documents whose passages to embed. */
  passageSourceKeys?: string[];
}

export interface SweepResult {
  events: SweepCounts;
  groups: SweepCounts;
  passages: SweepCounts;
}

const BATCH_SIZE = 32;

interface StaleCheck {
  stored_hash: string | null;
  stored_model: string | null;
  stored_dims: number | null;
}

interface Pending {
  id: string;
  text: string;
  hash: string;
}

/**
 * One pass of the `content_hash` sweep (plans/23, "Staleness"): compose every
 * event's and sequence's text, and re-embed exactly the rows whose stored
 * vector is missing, from another model or size, or for different text.
 *
 * The admin app and hand-edited sequences have no queue to tell anyone a row
 * changed, so the sweep compares instead of listening. Composing every row on
 * every pass is cheap at this size (hundreds of rows, no network); embedding
 * is the only cost, and it happens only for what changed.
 *
 * Batches are written as they finish, so a failure part-way keeps what was
 * done, and the next pass picks up the rest. Upserts are conditional on the
 * event or group still existing, so a row deleted mid-sweep is skipped, not
 * an error.
 */
export async function runEmbeddingSweep(
  db: SqlRunner,
  engine: EmbeddingEngine,
  scope: SweepScope = {},
): Promise<SweepResult> {
  return {
    events: await sweepEvents(db, engine, scope.eventSourceIds ?? null),
    groups: await sweepGroups(db, engine, scope.groupIds ?? null),
    passages: await sweepPassages(db, engine, scope.passageSourceKeys ?? null),
  };
}

/**
 * Passages need no hash: their text never changes in place — a re-cut deletes
 * and re-inserts — so a row needs embedding exactly when its `embedding` is
 * NULL or from another model.
 */
async function sweepPassages(
  db: SqlRunner,
  engine: EmbeddingEngine,
  sourceKeys: string[] | null,
): Promise<SweepCounts> {
  const [{ checked }] = (await db.query(
    `SELECT count(*)::int AS checked
       FROM document_passages p
       JOIN ingest_documents d ON d.id = p.document_id
       JOIN ingest_sources s ON s.id = d.source_id
      WHERE $1::text[] IS NULL OR s.key = ANY($1)`,
    [sourceKeys],
  )) as Array<{ checked: number }>;
  const rows = (await db.query(
    `SELECT p.document_id, p.seq, p.text
       FROM document_passages p
       JOIN ingest_documents d ON d.id = p.document_id
       JOIN ingest_sources s ON s.id = d.source_id
      WHERE ($1::text[] IS NULL OR s.key = ANY($1))
        AND (p.embedding IS NULL OR p.embedding_model IS DISTINCT FROM $2)
      ORDER BY p.document_id, p.seq`,
    [sourceKeys, engine.model],
  )) as Array<{ document_id: string; seq: number; text: string }>;

  const pending: Pending[] = rows.map((r) => ({
    id: `${r.document_id}#${r.seq}`,
    text: r.text,
    hash: "",
  }));
  await embedInBatches(engine, pending, (item, vector) => {
    const [documentId, seq] = item.id.split("#");
    // Conditional on the text still being what was embedded: a re-cut
    // between the read and this write must not get the old paragraph's vector.
    return db.query(
      `UPDATE document_passages
          SET embedding = $3::vector, embedding_model = $4
        WHERE document_id = $1 AND seq = $2 AND text = $5`,
      [
        documentId,
        Number(seq),
        toVectorLiteral(vector),
        engine.model,
        item.text,
      ],
    );
  });
  return { checked, embedded: pending.length };
}

function isStale(
  row: StaleCheck,
  hash: string,
  engine: EmbeddingEngine,
): boolean {
  return (
    row.stored_hash !== hash ||
    row.stored_model !== engine.model ||
    row.stored_dims !== engine.dims
  );
}

async function sweepEvents(
  db: SqlRunner,
  engine: EmbeddingEngine,
  sourceIds: string[] | null,
): Promise<SweepCounts> {
  const rows = (await db.query(
    `
    SELECT e.id, e.title, e.description, e.date::text AS date,
           e.date_precision, e.date_text, l.name AS place_name,
           ee.content_hash AS stored_hash, ee.model AS stored_model,
           ee.dims AS stored_dims
      FROM events e
      JOIN locations l ON l.id = e.location_id
      LEFT JOIN event_embeddings ee ON ee.event_id = e.id
     WHERE $1::text[] IS NULL OR e.source_id = ANY($1)
     ORDER BY e.id`,
    [sourceIds],
  )) as Array<
    StaleCheck & {
      id: string;
      title: string;
      description: string;
      date: string;
      date_precision: DatePrecision | null;
      date_text: string | null;
      place_name: string;
    }
  >;

  const pending: Pending[] = [];
  for (const row of rows) {
    const text = composeEventText({
      title: row.title,
      description: row.description,
      placeName: row.place_name,
      date: row.date,
      datePrecision: row.date_precision,
      dateText: row.date_text,
    });
    const hash = contentHash(text);
    if (isStale(row, hash, engine)) pending.push({ id: row.id, text, hash });
  }

  await embedInBatches(engine, pending, (item, vector) =>
    db.query(
      `INSERT INTO event_embeddings
         (event_id, embedding, model, dims, content_hash, source_text, embedded_at)
       SELECT $1, $2::vector, $3, $4, $5, $6, now()
        WHERE EXISTS (SELECT 1 FROM events WHERE id = $1)
       ON CONFLICT (event_id) DO UPDATE SET
         embedding = EXCLUDED.embedding, model = EXCLUDED.model,
         dims = EXCLUDED.dims, content_hash = EXCLUDED.content_hash,
         source_text = EXCLUDED.source_text, embedded_at = now()`,
      [
        item.id,
        toVectorLiteral(vector),
        engine.model,
        engine.dims,
        item.hash,
        item.text,
      ],
    ),
  );
  return { checked: rows.length, embedded: pending.length };
}

async function sweepGroups(
  db: SqlRunner,
  engine: EmbeddingEngine,
  groupIds: string[] | null,
): Promise<SweepCounts> {
  const rows = (await db.query(
    `
    SELECT g.id, g.title, g.description,
           ge.content_hash AS stored_hash, ge.model AS stored_model,
           ge.dims AS stored_dims,
           COALESCE(array_agg(e.title ORDER BY m.seq)
                    FILTER (WHERE e.id IS NOT NULL), '{}') AS member_titles
      FROM event_groups g
      LEFT JOIN event_group_members m ON m.group_id = g.id
      LEFT JOIN events e ON e.id = m.event_id
      LEFT JOIN event_group_embeddings ge ON ge.group_id = g.id
     WHERE $1::text[] IS NULL OR g.id = ANY($1)
     GROUP BY g.id, ge.content_hash, ge.model, ge.dims
     ORDER BY g.id`,
    [groupIds],
  )) as Array<
    StaleCheck & {
      id: string;
      title: string;
      description: string | null;
      member_titles: string[];
    }
  >;

  const pending: Pending[] = [];
  for (const row of rows) {
    const text = composeGroupText({
      title: row.title,
      description: row.description,
      memberTitles: row.member_titles,
    });
    const hash = contentHash(text);
    if (isStale(row, hash, engine)) pending.push({ id: row.id, text, hash });
  }

  await embedInBatches(engine, pending, (item, vector) =>
    db.query(
      `INSERT INTO event_group_embeddings
         (group_id, embedding, model, dims, content_hash, source_text, embedded_at)
       SELECT $1, $2::vector, $3, $4, $5, $6, now()
        WHERE EXISTS (SELECT 1 FROM event_groups WHERE id = $1)
       ON CONFLICT (group_id) DO UPDATE SET
         embedding = EXCLUDED.embedding, model = EXCLUDED.model,
         dims = EXCLUDED.dims, content_hash = EXCLUDED.content_hash,
         source_text = EXCLUDED.source_text, embedded_at = now()`,
      [
        item.id,
        toVectorLiteral(vector),
        engine.model,
        engine.dims,
        item.hash,
        item.text,
      ],
    ),
  );
  return { checked: rows.length, embedded: pending.length };
}

async function embedInBatches(
  engine: EmbeddingEngine,
  pending: Pending[],
  write: (item: Pending, vector: number[]) => Promise<unknown>,
): Promise<void> {
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    const vectors = await engine.embed(batch.map((p) => p.text));
    for (const [j, item] of batch.entries()) {
      await write(item, vectors[j]);
    }
  }
}

/** pgvector's text form; no npm `pgvector` package needed (plan 23). */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.join(",")}]`;
}
