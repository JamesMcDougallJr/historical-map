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
 * Each stage runs as its own child process (`tsx apps/workers/<name>/src/
 * main.ts`), the same topology docker-compose.yml runs in every other
 * environment — not six NestFactory.createApplicationContext calls sharing
 * one Node process. That in-process approach silently died partway through
 * FetchModule's bootstrap with zero error output (confirmed: no stack
 * trace, no uncaughtException, no unhandledRejection — something more
 * severe than a catchable JS exception), immediately after DetectModule's
 * own context had already registered a BullMQ queue under the same name
 * FetchModule's queue registration collides with. Separate processes are
 * what every other environment actually runs, and don't share that kind
 * of in-process state at all.
 *
 * Resets only the ingest-owned tables (ingest_documents, ingest_sources,
 * ingest_extractions, ingest_event_candidates, geocode_cache) — never
 * sources/locations/events, which the real-backend Playwright suite
 * (e2e-real/) owns. The two can share the same database safely: this
 * script's fixture ids (local-directory source, "Fixture Town" et al.) never
 * collide with e2e-real's (fx-source-*, fx-loc-*).
 */
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
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

interface WorkerSpec {
  name: string;
  mainPath: string;
  port: number;
}

const WORKERS: WorkerSpec[] = [
  { name: "detect", mainPath: "apps/workers/detect/src/main.ts", port: 3101 },
  { name: "fetch", mainPath: "apps/workers/fetch/src/main.ts", port: 3102 },
  { name: "extract-text", mainPath: "apps/workers/extract-text/src/main.ts", port: 3105 },
  { name: "extract-events", mainPath: "apps/workers/extract-events/src/main.ts", port: 3103 },
  { name: "validate", mainPath: "apps/workers/validate/src/main.ts", port: 3106 },
  { name: "publish", mainPath: "apps/workers/publish/src/main.ts", port: 3104 },
];

const REPO_ROOT = path.resolve(__dirname, "..");

function startWorker(spec: WorkerSpec): ChildProcess {
  const child = spawn(
    "npx",
    ["tsx", spec.mainPath],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: String(spec.port) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const prefix = `[${spec.name}]`;
  child.stdout?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.log(`${prefix} ${line}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      console.error(`${prefix} ${line}`);
    }
  });
  child.on("exit", (code, signal) => {
    if (code !== null && code !== 0) {
      console.error(`${prefix} exited early with code ${code}`);
    } else if (signal) {
      console.log(`${prefix} killed by ${signal}`);
    }
  });
  return child;
}

async function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) return;
      lastError = new Error(`health check returned ${res.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `worker on port ${port} never became healthy within ${timeoutMs}ms: ${String(lastError)}`,
  );
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

  console.log("Starting pipeline stage worker processes...");
  const children = WORKERS.map((spec) => startWorker(spec));

  const connection = redisConnection();
  const queues = Object.values(QUEUE_NAMES).map(
    (name) => new Queue(name, { connection, prefix: BULLMQ_PREFIX }),
  );

  try {
    for (const spec of WORKERS) {
      console.log(`Waiting for ${spec.name} to report healthy on :${spec.port}...`);
      await waitForHealth(spec.port, 30_000);
    }
    console.log("All pipeline stages healthy.");

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
    for (const child of children) child.kill("SIGTERM");
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

// An overall hard ceiling, independent of every individual timeout inside
// main() (30s per health check, 60s per queue-idle wait — nowhere near
// enough, on their own, to add up to this): a run was cancelled after
// sitting on this step for 31+ minutes with no sign of any of those
// per-step timeouts having fired. Whatever the actual cause (a stuck
// Redis call that never resolves rather than rejecting, a worker process
// wedged in a way that doesn't affect job *counts*, ...), this guarantees
// the script fails fast and visibly instead of hanging the CI job for
// however long GitHub's own job timeout allows.
const HARD_TIMEOUT_MS = 5 * 60_000;

function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`run-ingestion-fixture.ts exceeded its ${ms}ms hard timeout`)),
        ms,
      ).unref(),
    ),
  ]);
}

withHardTimeout(main(), HARD_TIMEOUT_MS)
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
