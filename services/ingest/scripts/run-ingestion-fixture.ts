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
import { SPLITTER_VERSION } from "../libs/parsers/src/passages/split-passages";
import { backfillPassages } from "./backfill-passages";

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
      // `npx tsx <file>` is not one process: tsx runs esbuild as a separate
      // service process, so the tree is npx -> tsx -> esbuild (confirmed by
      // CI's own "Terminate orphan process" cleanup log naming stray node
      // *and* esbuild PIDs). Signalling just the npx PID only ever killed
      // the top of that tree — the esbuild/tsx descendants lived on, still
      // holding this process's stdout/stderr pipes open, which kept this
      // script's own event loop alive for the full 5-minute hard timeout
      // even after the pipeline had already finished successfully.
      // `detached: true` puts the whole tree in its own process group, so
      // killWorker below can signal all of it at once via the negative pid.
      detached: true,
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

/**
 * Signals a worker's whole process group (negative pid), not just the
 * `npx` pid `spawn` returned — see `startWorker`'s `detached: true` comment
 * for why signalling only the top process left tsx/esbuild descendants
 * running as orphans.
 */
function killWorker(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Group already gone (e.g. every process in it already exited).
  }
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

// Populated inside main() and read by the hard-timeout handler at the
// bottom of this file — see that handler's own comment for why this has
// to be reachable from outside main() at all.
const activeChildren: ChildProcess[] = [];
const activeQueues: Queue[] = [];

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
  activeChildren.push(...children);

  const connection = redisConnection();
  const queues = Object.values(QUEUE_NAMES).map(
    (name) => new Queue(name, { connection, prefix: BULLMQ_PREFIX }),
  );
  activeQueues.push(...queues);

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
      // detect always carries one permanently-delayed placeholder job for its
      // next scheduled tick (DetectionSchedulerService's upsertJobScheduler) —
      // see waitForQueueIdle's own doc comment.
      const expectedDelayed = stage === QUEUE_NAMES.DETECT ? 1 : 0;
      await waitForQueueIdle(queue, { timeoutMs: 60_000, expectedDelayed });
    }

    console.log("Asserting results...");
    await assertResults();
    console.log("Asserting search passages...");
    await assertPassages();
    console.log("OK — ingestion fixture pipeline produced the expected rows.");
  } finally {
    await Promise.all(queues.map((q) => q.close()));
    for (const child of children) killWorker(child, "SIGTERM");
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

    // People (plans/22): verbatim names plus normalised keys, honorifics
    // stripped only while two words remain, accents folded; an event naming
    // nobody writes no rows.
    const people: Array<{ title: string; name: string; name_norm: string }> =
      await dataSource.query(
        `SELECT e.title, ee.name, ee.name_norm
           FROM event_entities ee JOIN events e ON e.id = ee.event_id
          WHERE e.source_id = 'local-directory' AND ee.type = 'person'
          ORDER BY e.title, ee.name_norm`,
      );
    const got = JSON.stringify(people.map((p) => [p.title, p.name, p.name_norm]));
    const want = JSON.stringify([
      ["The Centennial Parade", "Mayor Ezra Fixture", "ezra fixture"],
      ["The Centennial Parade", "President Ulysses S. Grant", "ulysses s grant"],
      ["The Founding of Fixture Village", "Élise Fixture", "elise fixture"],
    ]);
    if (got !== want) {
      throw new Error(`event_entities: expected ${want}, got ${got}`);
    }
  } finally {
    await dataSource.destroy();
  }
}

interface PassageSnapshot {
  rows: string;
  links: string;
  extractions: number;
}

async function snapshotPassages(): Promise<PassageSnapshot> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  try {
    const rows = await dataSource.query(
      `SELECT document_id, seq, anchor, text, extractor_version, splitter_version
         FROM document_passages ORDER BY document_id, seq`,
    );
    const links = await dataSource.query(
      `SELECT document_id, seq, event_id FROM passage_events
        ORDER BY document_id, seq, event_id`,
    );
    const [{ n }] = await dataSource.query(
      `SELECT count(*)::int AS n FROM ingest_extractions`,
    );
    return { rows: JSON.stringify(rows), links: JSON.stringify(links), extractions: n };
  } finally {
    await dataSource.destroy();
  }
}

/**
 * extract-text wrote document_passages for every document, publish linked
 * every event whose quote is verbatim in a paragraph (the fake engine quotes
 * whole blocks, so all three), and re-cutting from the stored artifacts is
 * idempotent and touches nothing upstream.
 */
async function assertPassages(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();
  try {
    const perDoc: Array<{ id: string; n: number; versions: string }> =
      await dataSource.query(
        `SELECT d.id, count(p.seq)::int AS n,
                string_agg(DISTINCT p.extractor_version || '/' || p.splitter_version, ',') AS versions
           FROM ingest_documents d
           LEFT JOIN document_passages p ON p.document_id = d.id
          GROUP BY d.id`,
      );
    for (const doc of perDoc) {
      if (doc.n === 0) throw new Error(`document ${doc.id} has no passages`);
      if (!doc.versions?.endsWith(`/${SPLITTER_VERSION}`)) {
        throw new Error(`document ${doc.id} passages at versions ${doc.versions}`);
      }
    }
    const unlinked: Array<{ title: string }> = await dataSource.query(
      `SELECT e.title FROM events e
        WHERE e.source_id = 'local-directory'
          AND NOT EXISTS (SELECT 1 FROM passage_events pe WHERE pe.event_id = e.id)`,
    );
    if (unlinked.length > 0) {
      throw new Error(
        `expected every fixture event linked to its paragraph, unlinked: ${unlinked
          .map((e) => e.title)
          .join(", ")}`,
      );
    }
  } finally {
    await dataSource.destroy();
  }

  const before = await snapshotPassages();
  const result = await backfillPassages({});
  if (result.indexed !== 0) {
    throw new Error(`backfill re-indexed ${result.indexed} current document(s)`);
  }
  await backfillPassages({ force: true });
  const after = await snapshotPassages();
  if (after.rows !== before.rows) throw new Error("re-cut changed document_passages");
  if (after.links !== before.links) throw new Error("re-cut changed passage_events");
  if (after.extractions !== before.extractions) {
    throw new Error("re-cutting passages created ingest_extractions rows");
  }
}

// An overall hard ceiling, independent of every individual timeout inside
// main() (30s per health check, 60s per queue-idle wait — nowhere near
// enough, on their own, to add up to this): two runs in a row sat on this
// step for 30-45+ minutes with no sign of any of those per-step timeouts
// having fired, both manually cancelled.
//
// The first attempt at this safety net (`Promise.race` + `process.exitCode
// = 1`) did NOT work — the race's losing side (`main()`) keeps running in
// the background regardless of which promise "wins", so whatever was
// actually stuck stayed stuck, still holding the child-process/Redis
// handles that keep Node's event loop alive. `exitCode` only picks the
// code used *when* the process naturally exits; it is not a request to
// exit, and nothing was making that happen.
//
// This version actually tears down what it knows about — SIGKILL every
// spawned worker, force-close every Queue — and then calls `process.exit()`
// directly rather than waiting for a drain that was never going to happen
// on its own. `activeChildren`/`activeQueues` exist at module scope
// specifically so this handler can reach them without main() having to
// hand them back through a return value it may never produce.
const HARD_TIMEOUT_MS = 5 * 60_000;

function armHardTimeout(ms: number): void {
  setTimeout(() => {
    console.error(
      `run-ingestion-fixture.ts exceeded its ${ms}ms hard timeout — force-killing ` +
        `${activeChildren.length} worker process(es) and closing ${activeQueues.length} queue(s), then exiting.`,
    );
    for (const child of activeChildren) killWorker(child, "SIGKILL");
    // Queue.close() is itself async, but this path exists for exactly the
    // case where awaiting things doesn't work — fire-and-forget, then exit
    // on a short fixed delay so a slow close() can't reintroduce the hang.
    for (const queue of activeQueues) void queue.close();
    setTimeout(() => process.exit(1), 2000).unref();
  }, ms).unref();
}

armHardTimeout(HARD_TIMEOUT_MS);

// Explicit process.exit(), not a return and a drain: main()'s own finally
// block already killed every worker's process group and closed every Queue,
// but `npx tsx <file>` runs as npx -> tsx -> esbuild, and the npx-level
// ChildProcess's stdout/stderr pipes stay open — and keep this process's
// event loop alive — for as long as ANY process in that tree still holds
// the pipe's write end, which SIGTERM doesn't reliably guarantee even once
// delivered to the whole group. Observed directly: a run that printed "OK"
// and killed every child still sat alive for the full 5-minute hard timeout,
// and GitHub Actions' own post-job cleanup had to reap 5 stray node processes
// and 4 stray esbuild processes afterward. Exiting explicitly here sidesteps
// relying on that drain ever completing, the same lesson armHardTimeout above
// already encodes for the timeout path.
main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
