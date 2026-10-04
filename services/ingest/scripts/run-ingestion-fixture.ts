/**
 * Runs the full ingestion pipeline — detect → fetch → extract-text →
 * extract-events → validate → publish — against a tiny deterministic fixture
 * corpus, with a fake `ExtractionEngine` standing in for Groq. Real Postgres,
 * real Redis, real MinIO/S3, real queues; no real LLM or geocoder call.
 *
 *   ALLOW_TEST_DB_RESET=1 EXTRACTION_ENGINE=fake \
 *     POSTGRES_URL=postgres://postgres:password@localhost:5433/db \
 *     S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY_ID=minioadmin \
 *     S3_SECRET_ACCESS_KEY=minioadmin S3_BUCKET=ingest \
 *     npm run test:ingestion-fixture --workspace=services/ingest
 *
 * Boots each stage's root module with `NestFactory.createApplicationContext`
 * rather than `create()` — no HTTP listener needed, only the BullMQ
 * processors each module registers, which start consuming as soon as Nest
 * instantiates them.
 *
 * Resets only the ingest-owned tables (ingest_documents, ingest_sources,
 * ingest_extractions, ingest_event_candidates, geocode_cache) — never
 * sources/locations/events, which the real-backend Playwright suite
 * (e2e-real/) owns. The two can share the same database safely: this
 * script's fixture ids (local-directory source, "Fixture Town" et al.) never
 * collide with e2e-real's (fx-source-*, fx-loc-*).
 */
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import { Queue } from "bullmq";
import { createDataSource } from "../libs/database/src/data-source";
import { GeocodeCache, IngestDocument, IngestSource } from "../libs/database/src/entities";
import {
  BULLMQ_PREFIX,
  DETECT_JOB_OPTIONS,
  QUEUE_NAMES,
  waitForQueueIdle,
} from "../libs/queue/src";

async function resetIngestTables(): Promise<void> {
  if (process.env["ALLOW_TEST_DB_RESET"] !== "1") {
    throw new Error(
      "Refusing to run without ALLOW_TEST_DB_RESET=1 — this truncates " +
        "ingest_documents/ingest_sources/ingest_extractions/" +
        "ingest_event_candidates/geocode_cache in whatever database " +
        "POSTGRES_URL points at.",
    );
  }
  const dataSource = createDataSource();
  await dataSource.initialize();
  try {
    await dataSource.query(
      "TRUNCATE ingest_event_candidates, ingest_extractions, ingest_documents, " +
        "ingest_sources, geocode_cache RESTART IDENTITY CASCADE",
    );
  } finally {
    await dataSource.destroy();
  }
}

/** Mirrors scripts/seed-sources.ts's one row — duplicated rather than
 * imported, since that script is a standalone entrypoint, not a module. */
async function seedIngestSource(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  try {
    const repo = dataSource.getRepository(IngestSource);
    await repo.save(
      repo.create({
        key: "local-directory",
        displayName: "Fixture corpus",
        attribution: "Fixture document corpus",
        enabled: true,
        lookbackDays: null,
        pollCron: null,
      }),
    );
  } finally {
    await dataSource.destroy();
  }
}

/**
 * Pre-seeds geocode_cache for the fixture corpus's three place names, so
 * `publish` never calls the real WHG/Nominatim geocoder — GeocodingService
 * checks the cache before the provider (see geocoding.service.ts).
 */
async function seedGeocodeCache(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  try {
    const repo = dataSource.getRepository(GeocodeCache);
    const places: Array<{ name: string; lon: number; lat: number }> = [
      { name: "fixture town", lon: -111.5, lat: 40.5 },
      { name: "fixture valley", lon: -111.6, lat: 40.6 },
      { name: "fixture village", lon: -111.7, lat: 40.7 },
    ];
    for (const place of places) {
      await repo.save(
        repo.create({
          normalizedName: place.name,
          rawName: place.name,
          lon: place.lon,
          lat: place.lat,
          found: true,
          provider: "fixture",
          displayName: place.name,
          candidates: null,
        }),
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

function redisConnection() {
  return {
    host: process.env["REDIS_HOST"] ?? "localhost",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  };
}

async function main(): Promise<void> {
  if (process.env["EXTRACTION_ENGINE"] !== "fake") {
    throw new Error(
      "Set EXTRACTION_ENGINE=fake — this script is not meant to spend real " +
        "Groq quota.",
    );
  }
  process.env["INGEST_CORPUS_DIR"] ??= path.resolve(
    __dirname,
    "..",
    "test-fixtures",
    "corpus",
  );

  console.log("Resetting ingest tables...");
  await resetIngestTables();
  console.log("Seeding fixture source and geocode cache...");
  await seedIngestSource();
  await seedGeocodeCache();

  console.log("Booting pipeline stages...");
  // Each stage's root module registers its BullMQ processor(s) on
  // instantiation — createApplicationContext is enough, no HTTP needed.
  const { DetectModule } = await import("../apps/workers/detect/src/detect.module");
  const { FetchModule } = await import("../apps/workers/fetch/src/fetch.module");
  const { ExtractTextModule } = await import(
    "../apps/workers/extract-text/src/extract-text.module"
  );
  const { ExtractEventsModule } = await import(
    "../apps/workers/extract-events/src/extract-events.module"
  );
  const { ValidateModule } = await import("../apps/workers/validate/src/validate.module");
  const { PublishModule } = await import("../apps/workers/publish/src/publish.module");

  const apps = await Promise.all([
    NestFactory.createApplicationContext(DetectModule, { logger: false }),
    NestFactory.createApplicationContext(FetchModule, { logger: false }),
    NestFactory.createApplicationContext(ExtractTextModule, { logger: false }),
    NestFactory.createApplicationContext(ExtractEventsModule, { logger: false }),
    NestFactory.createApplicationContext(ValidateModule, { logger: false }),
    NestFactory.createApplicationContext(PublishModule, { logger: false }),
  ]);

  const connection = redisConnection();
  const queues = Object.values(QUEUE_NAMES).map(
    (name) => new Queue(name, { connection, prefix: BULLMQ_PREFIX }),
  );

  try {
    console.log("Triggering detect...");
    const detectQueue = queues.find((q) => q.name === QUEUE_NAMES.DETECT)!;
    await detectQueue.add(
      "poll-source",
      { sourceKey: "local-directory" },
      DETECT_JOB_OPTIONS,
    );

    for (const stage of [
      QUEUE_NAMES.DETECT,
      QUEUE_NAMES.FETCH,
      QUEUE_NAMES.EXTRACT_TEXT,
      QUEUE_NAMES.EXTRACT_EVENTS,
      QUEUE_NAMES.VALIDATE,
      QUEUE_NAMES.PUBLISH,
    ]) {
      console.log(`Waiting for ${stage} to go idle...`);
      const queue = queues.find((q) => q.name === stage)!;
      await waitForQueueIdle(queue, { timeoutMs: 60_000 });
    }

    console.log("Asserting results...");
    await assertResults();
    console.log("OK — ingestion fixture pipeline produced the expected rows.");
  } finally {
    await Promise.all(queues.map((q) => q.close()));
    await Promise.all(apps.map((app) => app.close()));
  }
}

async function assertResults(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  try {
    const documentRepo = dataSource.getRepository(IngestDocument);
    const documents = await documentRepo.find();
    if (documents.length !== 2) {
      throw new Error(
        `expected 2 ingest_documents (one per fixture file), got ${documents.length}`,
      );
    }
    const unpublished = documents.filter((d) => d.status !== "published");
    if (unpublished.length > 0) {
      throw new Error(
        `expected every document published, got statuses: ${unpublished
          .map((d) => `${d.title ?? d.externalId}=${d.status}`)
          .join(", ")}`,
      );
    }

    const events: Array<{ title: string }> = await dataSource.query(
      `SELECT title FROM events WHERE source_id = 'local-directory' ORDER BY title`,
    );
    const titles = events.map((e) => e.title);
    const expected = [
      "The Centennial Parade",
      "The Founding of Fixture Village",
      "The New Railway Line",
    ];
    for (const title of expected) {
      if (!titles.includes(title)) {
        throw new Error(
          `expected a published event titled "${title}", got: ${titles.join(", ")}`,
        );
      }
    }
  } finally {
    await dataSource.destroy();
  }
}

// `process.exitCode =`, not `process.exit()`: the latter can truncate a
// large `console.error(error)` write to a piped (non-TTY) stdout/stderr —
// Node doesn't guarantee that write has actually flushed before the
// process-exit call tears the process down, so a big NestJS exception
// dump can vanish entirely in CI's captured log while still "crashing" in
// under a second with nothing visible — exactly what happened here before
// this fix. Setting exitCode and letting the event loop drain naturally
// guarantees the write completes first.
main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
