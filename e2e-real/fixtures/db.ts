// Seeds the real-backend suite's fixture dataset directly via
// lib/postgres-storage.ts, bypassing HTTP so seeding doesn't need the
// webServer up yet.
import {
  ensureSchema,
  sqlClient,
  upsertEventGroup,
  upsertLocation,
  upsertSource,
  setEventGroupMembers,
} from "../../lib/postgres-storage";
import { applyMartinFunctions } from "../../scripts/apply-martin-functions";
import { FX_GROUP, FX_LOCATIONS, FX_SOURCES } from "./seed-data";
import { embeddingEngineFromEnv } from "@historical-map/embedding";
import { runEmbeddingSweep } from "../../services/ingest/libs/embedding/src/sweep";
import {
  DISTRACTOR_LOCATION,
  DISTRACTOR_SOURCE,
  FX_INGEST_SOURCE_ID,
  PEOPLE_LOCATION,
  SEARCH_DOCUMENT_EVENTS,
  SEARCH_DOCUMENT_LOCATION,
  SEARCH_DOCUMENTS,
  SEARCH_GROUP,
  SEARCH_LOCATIONS,
  SEARCH_SOURCE,
} from "./search-seed";
import {
  replacePassages,
  type Queryable,
  type TransactionalQueryable,
} from "../../services/ingest/libs/parsers/src/passages/passage-store";

export async function seedFixtureData(): Promise<void> {
  await ensureSchema();
  await applyMartinFunctions();

  for (const source of FX_SOURCES) await upsertSource(source);
  for (const location of FX_LOCATIONS) await upsertLocation(location);

  await upsertEventGroup({
    id: FX_GROUP.id,
    title: FX_GROUP.title,
    description: FX_GROUP.description,
  });
  await setEventGroupMembers(FX_GROUP.id, FX_GROUP.memberEventIds);

  // The search corpus (search-seed.ts) — its own source, so it is its own layer.
  await upsertSource(SEARCH_SOURCE);
  for (const location of SEARCH_LOCATIONS) await upsertLocation(location);
  await upsertLocation(PEOPLE_LOCATION);
  await upsertEventGroup({
    id: SEARCH_GROUP.id,
    title: SEARCH_GROUP.title,
    description: SEARCH_GROUP.description,
  });
  await setEventGroupMembers(SEARCH_GROUP.id, SEARCH_GROUP.memberEventIds);
  await upsertSource(DISTRACTOR_SOURCE);
  await upsertLocation(DISTRACTOR_LOCATION);
  await seedSearchDocuments();
  await embedFixtureData();
}

/**
 * Vectors for every fixture event, sequence and passage (plans/23), by the
 * same sweep the `embed` worker runs. `EMBEDDING_ENGINE` picks the engine —
 * `fake` (the config's default) serves e2e-real/fixtures/search-vectors.json
 * and throws, naming the text, on anything unrecorded; `record` fills the file
 * from live Bedrock. Scoped to this suite's own rows: in CI the database also
 * holds the ingestion fixture's.
 */
export async function embedFixtureData(): Promise<void> {
  const sql = sqlClient();
  const db = {
    query: (text: string, params?: unknown[]) =>
      sql.unsafe(text, (params ?? []) as never[]),
  };
  await runEmbeddingSweep(db, embeddingEngineFromEnv(), {
    eventSourceIds: [
      ...FX_SOURCES.map((s) => s.id),
      SEARCH_SOURCE.id,
      DISTRACTOR_SOURCE.id,
    ],
    groupIds: [FX_GROUP.id, SEARCH_GROUP.id],
    passageSourceKeys: [SEARCH_SOURCE.id],
  });
}

/**
 * The search corpus's ingested documents: ingest_sources/ingest_documents
 * rows, their passages, and events published from them.
 *
 * The ingest tables belong to services/ingest (and the ingestion fixture
 * test truncates them), so this deletes only its own rows, by id, rather than
 * truncating — neither suite can wipe the other's data. Needs ingest
 * migrations applied: `npm run migrate --workspace=services/ingest`.
 */
export async function seedSearchDocuments(): Promise<void> {
  const sql = sqlClient();
  const [row] = await sql<{ ok: boolean }[]>`
    SELECT to_regclass('document_passages') IS NOT NULL AS ok`;
  if (!row?.ok) {
    throw new Error(
      "document_passages is missing — run `npm run migrate --workspace=services/ingest` " +
        "before the real-backend suite (search fixtures need the ingest tables).",
    );
  }

  const ids = SEARCH_DOCUMENTS.map((d) => d.id);
  await sql`DELETE FROM ingest_documents WHERE id = ANY(${ids}::uuid[])`;
  await sql`DELETE FROM ingest_sources WHERE id = ${FX_INGEST_SOURCE_ID}::uuid OR key = ${SEARCH_SOURCE.id}`;
  await sql`
    INSERT INTO ingest_sources (id, key, display_name, enabled)
    VALUES (${FX_INGEST_SOURCE_ID}::uuid, ${SEARCH_SOURCE.id}, ${SEARCH_SOURCE.name}, false)`;
  for (const doc of SEARCH_DOCUMENTS) {
    await sql`
      INSERT INTO ingest_documents (id, source_id, external_id, url, title, status)
      VALUES (${doc.id}::uuid, ${FX_INGEST_SOURCE_ID}::uuid, ${doc.externalId},
              ${"file:///fixtures/" + doc.externalId}, ${doc.title}, 'published')`;
  }

  await upsertLocation({ ...SEARCH_DOCUMENT_LOCATION, events: [] });
  const [doc1] = SEARCH_DOCUMENTS;
  for (const e of SEARCH_DOCUMENT_EVENTS) {
    await sql`
      INSERT INTO events (id, location_id, source_id, title, date, description,
                          source, date_precision, document_id, anchor)
      VALUES (${e.id}, ${SEARCH_DOCUMENT_LOCATION.id}, ${SEARCH_SOURCE.id}, ${e.title},
              ${e.date}, ${e.description}, ${e.source}, ${e.datePrecision},
              ${doc1!.id}::uuid, ${e.anchor})
      ON CONFLICT (id) DO NOTHING`;
  }

  // The real writer: split, insert, then link events to paragraphs.
  const asQueryable = (
    run: (q: string, p?: unknown[]) => Promise<unknown>,
  ): Queryable => ({
    query: run,
  });
  const db: TransactionalQueryable = {
    query: (q, p) => sql.unsafe(q, (p ?? []) as never[]),
    transaction: (fn) =>
      sql.begin((tx) =>
        fn(asQueryable((q, p) => tx.unsafe(q, (p ?? []) as never[]))),
      ) as never,
  };
  for (const doc of SEARCH_DOCUMENTS) {
    await replacePassages(db, doc.id, doc.segments, 2);
  }
}
