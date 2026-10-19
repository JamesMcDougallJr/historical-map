// Seeds the shared preview database with something every kind of search can
// find: the demo data (`npm run seed:db`, run first) plus the search corpus
// from e2e-real/fixtures/search-seed.ts — paraphrase events, people, a
// sequence, and two ingested documents with passages — embedded with the
// recorded vectors, since previews have no Bedrock (EMBEDDING_ENGINE=fake).
//
//   POSTGRES_URL=... npm run db:ensure-schema
//   POSTGRES_URL=... npm run migrate --workspace=services/ingest
//   POSTGRES_URL=... npm run seed:db
//   POSTGRES_URL=... npm run seed:preview
//
// Leaves out e2e-real's map fixtures and its fifty vector distractors, which
// exist to test things, not to look at. Idempotent: rows upsert, documents
// are replaced by id, and the embed sweep only embeds what's missing.
//
// By meaning, previews can only answer queries whose vectors were recorded
// (the golden set and the hybrid spec's); any other query falls back to text
// search and says "Search by meaning unavailable".
//
// A pure CLI entry point with no exports, like scripts/seed-db.ts.

import { embeddingEngineFromEnv } from "@historical-map/embedding";
import { seedSearchDocuments } from "../e2e-real/fixtures/db";
import {
  PEOPLE_LOCATION,
  SEARCH_GROUP,
  SEARCH_LOCATIONS,
  SEARCH_SOURCE,
} from "../e2e-real/fixtures/search-seed";
import {
  ensureSchema,
  setEventGroupMembers,
  sqlClient,
  upsertEventGroup,
  upsertLocation,
  upsertSource,
} from "../lib/postgres-storage";
import { runEmbeddingSweep } from "../services/ingest/libs/embedding/src/sweep";

async function main(): Promise<void> {
  if (!process.env["POSTGRES_URL"]) throw new Error("Set POSTGRES_URL.");
  process.env["EMBEDDING_ENGINE"] ??= "fake";

  await ensureSchema();
  await upsertSource(SEARCH_SOURCE);
  for (const location of SEARCH_LOCATIONS) await upsertLocation(location);
  await upsertLocation(PEOPLE_LOCATION);
  await upsertEventGroup({
    id: SEARCH_GROUP.id,
    title: SEARCH_GROUP.title,
    description: SEARCH_GROUP.description,
  });
  await setEventGroupMembers(SEARCH_GROUP.id, SEARCH_GROUP.memberEventIds);
  await seedSearchDocuments();

  const sql = sqlClient();
  const result = await runEmbeddingSweep(
    {
      query: (text: string, params?: unknown[]) =>
        sql.unsafe(text, (params ?? []) as never[]),
    },
    embeddingEngineFromEnv(),
    {
      eventSourceIds: [SEARCH_SOURCE.id],
      groupIds: [SEARCH_GROUP.id],
      passageSourceKeys: [SEARCH_SOURCE.id],
    },
  );
  console.log(
    `Search corpus seeded; embedded ${result.events.embedded}/${result.events.checked} events, ` +
      `${result.groups.embedded}/${result.groups.checked} sequences, ` +
      `${result.passages.embedded}/${result.passages.checked} passages.`,
  );
  await sql.end();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
