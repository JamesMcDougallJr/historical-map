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
 * ingest_extractions, ingest_event_candidates, geocode_cache) plus its own
 * `local-directory` events — never anything else in sources/locations/events,
 * which the real-backend Playwright suite
 * (e2e-real/) owns. The two can share the same database safely: this
 * script's fixture ids (local-directory source, "Fixture Town" et al.) never
 * collide with e2e-real's (fx-source-*, fx-loc-*).
 *
 * `JEV_FIXTURE=1` runs the same pipeline a second way: with
 * `JEV_GROUNDING_ENABLED`/`JEV_DEDUP_SCORING_ENABLED`/
 * `JEV_CONFIDENCE_RESCORE_ENABLED` turned on and `JEV_API_KEY`/`JEV_BASE_URL`
 * pointed at a fake local Jev HTTP server, then asserts the resulting
 * `*-jev` checks actually landed in `ingest_event_candidates.checks`. This
 * is the one test in the whole suite that boots the real `validate` worker
 * process (via `tsx`, exactly like every other environment) with Jev wired
 * in — `verify-jev.ts`'s mocked-fetch tests prove the client and check
 * functions are correct in isolation, but cannot catch a Nest DI wiring
 * mistake (see `HealthController`'s comment for why that failure mode is
 * real here: it silently resolves to `undefined` under `tsx`, not a boot
 * error). This mode is what would have caught it.
 *
 *   JEV_FIXTURE=1 ALLOW_TEST_DB_RESET=1 EXTRACTION_ENGINE=fake \
 *     npm run test:ingestion-fixture:jev --workspace=services/ingest
 */
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { Queue } from "bullmq";
import type { DataSource } from "typeorm";
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
    // The fixture's own published events too. `publish` is idempotent
    // (`ON CONFLICT DO NOTHING` on a deterministic id), so rows left by a
    // previous run make a later run report `already-present` and — worse —
    // make "was this event kept off the map" unanswerable, since an earlier
    // run (e.g. the baseline, with Jev off) may have published it. Scoped to
    // the fixture's source id; never touches e2e-real's `fx-source-*` rows.
    await dataSource.query("DELETE FROM events WHERE source_id = 'local-directory'");
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

interface FakeJevServer {
  port: number;
  close: () => Promise<void>;
}

/**
 * A minimal stand-in for Jev itself (the real service isn't reachable from
 * CI, and this script doesn't spend real API quota any more than it spends
 * real Groq quota — see `EXTRACTION_ENGINE=fake` above).
 *
 * Speaks TypeSafe's real `POST /v1/systemone` contract, and is deliberately
 * strict about the request: a missing bearer token, a wrong path/method, or a
 * body that isn't `{ model, state, questions }` gets a 401/404/422 — which
 * `JevClient.tryAsk` swallows, so a request-shape regression shows up as the
 * missing `*-jev` checks `assertJevChecksRecorded` looks for, rather than
 * passing quietly against a lenient fake.
 *
 * Answers by question `type`, with uniform canned values:
 *   - noul: 0.77 (leans "yes")
 *   - choice: the `none` label when offered, else the first label
 *   - score: 3 on whatever rubric was sent
 */
function startFakeJevServer(): Promise<FakeJevServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const reply = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        if (req.method !== "POST" || req.url !== "/v1/systemone") {
          return reply(404, { error: "not found" });
        }
        if (!String(req.headers["authorization"] ?? "").startsWith("Bearer ")) {
          return reply(401, { error: "missing bearer token" });
        }
        let body: any;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return reply(422, { error: "body is not JSON" });
        }
        const questions = body?.questions;
        if (
          typeof body?.model !== "string" ||
          body?.state === undefined ||
          typeof questions !== "object" ||
          questions === null ||
          Object.keys(questions).length === 0
        ) {
          return reply(422, { error: "expected { model, state, questions }" });
        }

        const answers: Record<string, unknown> = {};
        for (const [name, q] of Object.entries<any>(questions)) {
          if (q?.type === "noul") {
            answers[name] = { type: "noul", noul: 0.77 };
          } else if (q?.type === "choice" && q.criteria) {
            const labels = Object.keys(q.criteria);
            // The grounding relation question: the fixture's `[contradicted]`
            // quote (see FakeExtractionEngine) is the one Jev disputes; every
            // other claim it supports. Other choices: `none` when offered.
            const disputed =
              labels.includes("contradicts") &&
              String(body.state?.claim ?? "").includes("[contradicted]");
            const pick = disputed
              ? "contradicts"
              : labels.includes("none")
                ? "none"
                : labels[0]!;
            answers[name] = {
              type: "choice",
              choice: pick,
              confidence: 0.9,
              probabilities: Object.fromEntries(labels.map((l) => [l, l === pick ? 0.9 : 0.1 / Math.max(1, labels.length - 1)])),
            };
          } else if (q?.type === "score" && Array.isArray(q.criteria)) {
            answers[name] = {
              type: "score",
              score: 3,
              confidence: 0.8,
              legend: Object.fromEntries(q.criteria.map((c: unknown, i: number) => [String(i), c])),
              probabilities: Object.fromEntries(q.criteria.map((_: unknown, i: number) => [String(i), i === 3 ? 1 : 0])),
            };
          } else {
            return reply(422, { error: `unsupported question "${name}"` });
          }
        }
        reply(200, { model: body.model, answers, usage: { input_tokens: 1, output_tokens: 1 } });
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address === null) {
        reject(new Error("fake Jev server has no address after listen()"));
        return;
      }
      resolve({
        port: address.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
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

// Health-check ports are PORT_BASE+1..+6. Overridable so the fixture can run
// beside another stack's long-lived workers (set REDIS_PORT/POSTGRES_URL to an
// isolated stack too — the queue prefix is shared, so a shared Redis races jobs).
const PORT_BASE = Number(process.env["FIXTURE_PORT_BASE"] ?? 3100);

const WORKERS: WorkerSpec[] = [
  { name: "detect", mainPath: "apps/workers/detect/src/main.ts", port: PORT_BASE + 1 },
  { name: "fetch", mainPath: "apps/workers/fetch/src/main.ts", port: PORT_BASE + 2 },
  { name: "extract-text", mainPath: "apps/workers/extract-text/src/main.ts", port: PORT_BASE + 5 },
  { name: "extract-events", mainPath: "apps/workers/extract-events/src/main.ts", port: PORT_BASE + 3 },
  { name: "validate", mainPath: "apps/workers/validate/src/main.ts", port: PORT_BASE + 6 },
  { name: "publish", mainPath: "apps/workers/publish/src/main.ts", port: PORT_BASE + 4 },
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
let activeFakeJevServer: FakeJevServer | undefined;

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

  const jevMode = process.env["JEV_FIXTURE"] === "1";
  let fakeJevServer: FakeJevServer | undefined;
  if (jevMode) {
    fakeJevServer = await startFakeJevServer();
    activeFakeJevServer = fakeJevServer;
    // Set before `startWorker` spawns anything below — each child inherits
    // `process.env` as a snapshot taken at spawn time, so these must land
    // first or the workers never see them.
    process.env["JEV_API_KEY"] = "fixture-test-key";
    process.env["JEV_BASE_URL"] = `http://127.0.0.1:${fakeJevServer.port}`;
    process.env["JEV_GROUNDING_ENABLED"] = "true";
    // Gate on, so the run proves a contradicted quote is actually held.
    process.env["JEV_GROUNDING_MIN_SUPPORT"] = "0.5";
    process.env["JEV_DEDUP_SCORING_ENABLED"] = "true";
    process.env["JEV_CONFIDENCE_RESCORE_ENABLED"] = "true";
    console.log(
      `JEV_FIXTURE=1 — fake Jev server on :${fakeJevServer.port}, grounding/dedup/confidence checks enabled`,
    );
  }

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
    await assertResults(jevMode);
    console.log("OK — ingestion fixture pipeline produced the expected rows.");
  } finally {
    await Promise.all(queues.map((q) => q.close()));
    for (const child of children) killWorker(child, "SIGTERM");
    if (fakeJevServer) await fakeJevServer.close();
  }
}

async function assertResults(jevMode: boolean): Promise<void> {
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

    // Only `grounding-jev` can gate (JEV_GROUNDING_MIN_SUPPORT), and only on
    // a quote the exact-match check missed. A wiring mistake (wrong DI token,
    // wrong env var name, fake server unreachable) fails open, so it shows up
    // as a missing check or an unheld event below, never as a crash.
    if (jevMode) {
      await assertJevChecksRecorded(dataSource, titles);
    } else if (!titles.includes("The Disputed Treaty")) {
      // Without Jev nothing may hold the contradicted event: the baseline
      // run proves the paraphrase fixtures don't change pre-Jev behaviour.
      throw new Error('baseline run should publish "The Disputed Treaty" (Jev is off)');
    }
  } finally {
    await dataSource.destroy();
  }
}

/**
 * Proves the Jev checks actually got into `ingest_event_candidates.checks`,
 * not just that `JevClient` can be unit-tested in isolation (`verify-jev.ts`
 * does that). Every one of these three names comes from a real HTTP round
 * trip, through the real `validate` worker process, through Nest's DI
 * container — exactly the path a wiring mistake would break silently.
 *
 * Does not assert on `duplicate-jev`: it only fires when a same-year event
 * was already seen earlier in the same run, which this fixture corpus may
 * or may not produce depending on fixture dates, so asserting on
 * it would make the test depend on corpus details unrelated to what this is
 * actually checking.
 */
async function assertJevChecksRecorded(
  dataSource: DataSource,
  publishedTitles: string[],
): Promise<void> {
  const rows: Array<{
    verdict: string;
    event: { title: string };
    checks: Array<{ name: string; passed: boolean; gating: boolean }>;
  }> = await dataSource.query(
    `SELECT verdict, event, checks FROM ingest_event_candidates`,
  );
  const names = new Set(rows.flatMap((r) => r.checks.map((c) => c.name)));

  for (const expectedName of ["grounding-jev", "confidence-jev"]) {
    if (!names.has(expectedName)) {
      throw new Error(
        `JEV_FIXTURE=1 but no "${expectedName}" check was recorded on any ` +
          `candidate — the Jev integration either isn't wired correctly in ` +
          `the validate worker, or the fake Jev server was never reached. ` +
          `Recorded check names: ${[...names].join(", ") || "(none)"}`,
      );
    }
  }

  const byTitle = (title: string) => rows.find((r) => r.event.title === title);

  // Supported paraphrase: Jev was consulted, the gate is active, it passed.
  const supported = byTitle("The Surveyors Arrival");
  const supportedCheck = supported?.checks.find((c) => c.name === "grounding-jev");
  if (!supportedCheck?.gating || !supportedCheck.passed || supported?.verdict !== "publish") {
    throw new Error(
      `"The Surveyors Arrival" (paraphrased, Jev supports) should carry a ` +
        `passing gating grounding-jev check and publish; got ${JSON.stringify(supported)}`,
    );
  }

  // Contradicted paraphrase: held for review by the gate, never published.
  const disputed = byTitle("The Disputed Treaty");
  const disputedCheck = disputed?.checks.find((c) => c.name === "grounding-jev");
  if (!disputedCheck?.gating || disputedCheck.passed || disputed?.verdict !== "review") {
    throw new Error(
      `"The Disputed Treaty" (paraphrased, Jev contradicts) should be held ` +
        `for review by a failed gating grounding-jev check; got ${JSON.stringify(disputed)}`,
    );
  }
  if (publishedTitles.includes("The Disputed Treaty")) {
    throw new Error('"The Disputed Treaty" was held for review but still reached the map');
  }

  // Exact-match quotes never go to Jev, so they carry no grounding-jev check.
  const verbatim = byTitle("The Centennial Parade");
  if (verbatim?.checks.some((c) => c.name === "grounding-jev")) {
    throw new Error('"The Centennial Parade" quotes the document verbatim and must not be sent to Jev');
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
    if (activeFakeJevServer) void activeFakeJevServer.close();
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
