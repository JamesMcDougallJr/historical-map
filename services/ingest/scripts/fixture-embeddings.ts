/**
 * The ingestion fixture's embed-sweep checks (plans/23-search-semantic.md,
 * "Ingestion fixture — the embed sweep"), run after `publish` by
 * run-ingestion-fixture.ts.
 *
 * Runs the sweep in-process, scoped to the fixture's own source and sequence,
 * because in CI this database also holds e2e-real's rows. The engine is
 * whatever `EMBEDDING_ENGINE` selects — `fake` in CI, `record` when
 * (re)recording `search-vectors.json` — wrapped so each check can see exactly
 * which texts were sent.
 */
import type { DataSource } from "typeorm";
import { createDataSource } from "../libs/database/src/data-source";
import {
  composeEventText,
  composeGroupText,
  contentHash,
  embeddingEngineFromEnv,
  runEmbeddingSweep,
  type EmbeddingEngine,
  type SweepScope,
} from "../libs/embedding/src";
import { backfillPassages } from "./backfill-passages";
import { FIXTURE_SOURCE_KEY } from "./fixture-guard";

export const FIXTURE_GROUP_ID = "ingest-fixture-sequence";

/** Records every text sent, and can claim a different model name. */
class LoggingEngine implements EmbeddingEngine {
  readonly engineName: string;
  readonly sent: string[] = [];
  constructor(
    private readonly inner: EmbeddingEngine,
    readonly model = inner.model,
  ) {
    this.engineName = inner.engineName;
  }
  get dims(): number {
    return this.inner.dims;
  }
  async embed(texts: string[]): Promise<number[][]> {
    this.sent.push(...texts);
    return this.inner.embed(texts);
  }
}

function fail(message: string): never {
  throw new Error(`embed sweep: ${message}`);
}

export async function assertEmbeddings(): Promise<void> {
  const db = createDataSource();
  await db.initialize();
  try {
    await run(db);
  } finally {
    await db.destroy();
  }
}

async function run(db: DataSource): Promise<void> {
  const base = embeddingEngineFromEnv();
  const scope: SweepScope = {
    eventSourceIds: [FIXTURE_SOURCE_KEY],
    groupIds: [FIXTURE_GROUP_ID],
    passageSourceKeys: [FIXTURE_SOURCE_KEY],
  };
  const passageFilter = `document_id IN (
      SELECT d.id FROM ingest_documents d JOIN ingest_sources s ON s.id = d.source_id
       WHERE s.key = '${FIXTURE_SOURCE_KEY}')`;
  const passageStats = async (): Promise<{
    rows: number;
    missing: number;
    models: string[];
  }> =>
    (
      await db.query(
        `SELECT count(*)::int AS rows,
                count(*) FILTER (WHERE embedding IS NULL)::int AS missing,
                COALESCE(array_agg(DISTINCT embedding_model)
                         FILTER (WHERE embedding_model IS NOT NULL), '{}') AS models
           FROM document_passages WHERE ${passageFilter}`,
      )
    )[0];

  type EventRow = {
    id: string;
    title: string;
    description: string;
    date: string;
    date_precision: string | null;
    date_text: string | null;
    place_name: string;
    quote: string | null;
  };
  const loadEvents = (): Promise<EventRow[]> =>
    db.query(
      `SELECT e.id, e.title, e.description, e.date::text AS date,
              e.date_precision, e.date_text, l.name AS place_name, e.source AS quote
         FROM events e JOIN locations l ON l.id = e.location_id
        WHERE e.source_id = $1 ORDER BY e.date, e.id`,
      [FIXTURE_SOURCE_KEY],
    );
  const composed = (e: EventRow): string =>
    composeEventText({
      title: e.title,
      description: e.description,
      placeName: e.place_name,
      date: e.date,
      datePrecision: e.date_precision as never,
      dateText: e.date_text,
    });

  const events = await loadEvents();
  if (events.length < 2)
    fail(`expected ≥ 2 published fixture events, got ${events.length}`);

  // A sequence over the fixture's events — the pipeline doesn't make one.
  await db.query(
    `INSERT INTO event_groups (id, title, description) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description`,
    [
      FIXTURE_GROUP_ID,
      "Ingestion fixture sequence",
      "Every event the fixture publishes.",
    ],
  );
  await db.query(`DELETE FROM event_group_members WHERE group_id = $1`, [
    FIXTURE_GROUP_ID,
  ]);
  for (const [seq, event] of events.entries()) {
    await db.query(
      `INSERT INTO event_group_members (group_id, event_id, seq) VALUES ($1, $2, $3)`,
      [FIXTURE_GROUP_ID, event.id, seq],
    );
  }

  // 1. A first pass embeds every event and the sequence, in plan 13's format.
  const first = new LoggingEngine(base);
  const r1 = await runEmbeddingSweep(db, first, scope);
  if (r1.events.embedded !== events.length || r1.groups.embedded !== 1) {
    fail(
      `first pass embedded ${JSON.stringify(r1)}, expected ${events.length} events and 1 group`,
    );
  }
  const expectedTexts = new Set(events.map(composed));
  for (const text of first.sent.slice(0, events.length)) {
    if (!expectedTexts.has(text))
      fail(`sent ${JSON.stringify(text)}, not a composed event text`);
  }
  for (const event of events) {
    if (event.quote && first.sent.some((t) => t.includes(event.quote!))) {
      fail(
        `event ${event.id}'s source quote was embedded; plan 13 leaves it out`,
      );
    }
  }
  const stored: Array<{
    event_id: string;
    model: string;
    dims: number;
    content_hash: string;
  }> = await db.query(
    `SELECT event_id, model, dims, content_hash FROM event_embeddings WHERE event_id = ANY($1)`,
    [events.map((e) => e.id)],
  );
  for (const event of events) {
    const row = stored.find((r) => r.event_id === event.id);
    if (!row) fail(`no event_embeddings row for ${event.id}`);
    if (row.model !== base.model || row.dims !== base.dims) {
      fail(
        `${event.id} stored ${row.model}/${row.dims}, expected ${base.model}/${base.dims}`,
      );
    }
    if (row.content_hash !== contentHash(composed(event))) {
      fail(`${event.id}'s content_hash doesn't match its composed text`);
    }
  }

  const passages = await passageStats();
  if (
    passages.rows === 0 ||
    passages.missing !== 0 ||
    r1.passages.embedded !== passages.rows ||
    passages.models.join() !== base.model
  ) {
    fail(
      `first pass left passages ${JSON.stringify(passages)} (embedded ${r1.passages.embedded})`,
    );
  }

  // 2. Nothing changed → nothing embedded, no call at all.
  const idle = new LoggingEngine(base);
  const r2 = await runEmbeddingSweep(db, idle, scope);
  if (
    idle.sent.length !== 0 ||
    r2.events.embedded + r2.groups.embedded + r2.passages.embedded !== 0
  ) {
    fail(`an unchanged corpus re-embedded ${idle.sent.length} text(s)`);
  }

  // 2b. Re-cutting passages (what a SPLITTER_VERSION or EXTRACTOR_VERSION bump
  // does) replaces the rows; the sweep embeds exactly those new rows.
  await backfillPassages({ force: true });
  const recut = await passageStats();
  if (recut.missing !== recut.rows) {
    fail(`a re-cut kept ${recut.rows - recut.missing} old passage vector(s)`);
  }
  const afterRecut = new LoggingEngine(base);
  const rRecut = await runEmbeddingSweep(db, afterRecut, scope);
  const recutTexts: Array<{ text: string }> = await db.query(
    `SELECT text FROM document_passages WHERE ${passageFilter} ORDER BY document_id, seq`,
  );
  if (
    rRecut.passages.embedded !== recut.rows ||
    rRecut.events.embedded + rRecut.groups.embedded !== 0 ||
    afterRecut.sent.join("\n") !== recutTexts.map((r) => r.text).join("\n") ||
    (await passageStats()).missing !== 0
  ) {
    fail(`after a re-cut the sweep sent ${afterRecut.sent.length} text(s)`);
  }

  // 3. Editing one event's description re-embeds that row only.
  const edited = events[0];
  await db.query(
    `UPDATE events SET description = description || ' Edited by the ingestion fixture.' WHERE id = $1`,
    [edited.id],
  );
  const afterEdit = new LoggingEngine(base);
  await runEmbeddingSweep(db, afterEdit, scope);
  const editedNow = (await loadEvents()).find((e) => e.id === edited.id)!;
  if (
    afterEdit.sent.length !== 1 ||
    afterEdit.sent[0] !== composed(editedNow)
  ) {
    fail(`editing one description sent ${JSON.stringify(afterEdit.sent)}`);
  }

  // 4. Renaming the sequence re-embeds the sequence only.
  await db.query(`UPDATE event_groups SET title = $2 WHERE id = $1`, [
    FIXTURE_GROUP_ID,
    "Ingestion fixture sequence, renamed",
  ]);
  const afterRename = new LoggingEngine(base);
  await runEmbeddingSweep(db, afterRename, scope);
  const members = (await loadEvents()).map((e) => e.title);
  const groupText = composeGroupText({
    title: "Ingestion fixture sequence, renamed",
    description: "Every event the fixture publishes.",
    memberTitles: members,
  });
  if (afterRename.sent.length !== 1 || afterRename.sent[0] !== groupText) {
    fail(`renaming the sequence sent ${JSON.stringify(afterRename.sent)}`);
  }

  // 5. A model change re-embeds everything, replacing rows rather than adding.
  const otherModel = new LoggingEngine(
    base,
    `${base.model}+fixture-model-change`,
  );
  const r5 = await runEmbeddingSweep(db, otherModel, scope);
  if (
    r5.events.embedded !== events.length ||
    r5.groups.embedded !== 1 ||
    r5.passages.embedded !== passages.rows
  ) {
    fail(`a model change embedded ${JSON.stringify(r5)}, expected everything`);
  }
  const afterModelChange = await passageStats();
  if (
    afterModelChange.missing !== 0 ||
    afterModelChange.models.join() !== otherModel.model
  ) {
    fail(`passages after a model change: ${JSON.stringify(afterModelChange)}`);
  }
  const [{ rows, models }]: Array<{ rows: number; models: string[] }> =
    await db.query(
      `SELECT count(*)::int AS rows, array_agg(DISTINCT model) AS models
       FROM event_embeddings WHERE event_id = ANY($1)`,
      [events.map((e) => e.id)],
    );
  if (
    rows !== events.length ||
    models.length !== 1 ||
    models[0] !== otherModel.model
  ) {
    fail(`after a model change: ${rows} rows, models ${models}`);
  }

  // 6. Unit length and honest dims, in both tables.
  for (const [table, key, ids] of [
    ["event_embeddings", "event_id", events.map((e) => e.id)],
    ["event_group_embeddings", "group_id", [FIXTURE_GROUP_ID]],
  ] as const) {
    const [check]: Array<{ worst: number; dims_ok: boolean }> = await db.query(
      `SELECT max(abs(vector_norm(embedding) - 1)) AS worst,
              bool_and(dims = vector_dims(embedding)) AS dims_ok
         FROM ${table} WHERE ${key} = ANY($1)`,
      [ids],
    );
    if (!(check.worst < 1e-3) || !check.dims_ok) {
      fail(
        `${table}: worst |‖v‖ − 1| = ${check.worst}, dims consistent: ${check.dims_ok}`,
      );
    }
  }
  const [passageNorms]: Array<{ worst: number; dims_ok: boolean }> =
    await db.query(
      `SELECT max(abs(vector_norm(embedding) - 1)) AS worst,
              bool_and(vector_dims(embedding) = $1) AS dims_ok
         FROM document_passages WHERE ${passageFilter}`,
      [base.dims],
    );
  if (!(passageNorms.worst < 1e-3) || !passageNorms.dims_ok) {
    fail(`document_passages: ${JSON.stringify(passageNorms)}`);
  }
}
