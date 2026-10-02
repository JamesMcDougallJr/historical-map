/**
 * One-off: proposes and applies narrative sequences for documents that were
 * published before `extract-events` learned to do this automatically.
 *
 *   POSTGRES_URL=... GROQ_API_KEY=... npm run backfill-sequences --workspace=services/ingest
 *
 * For every published document with no `ingest_event_sequences` rows yet:
 * calls the same `GroqExtractionEngine.proposeSequences` the live pipeline
 * uses, persists the proposals, then re-enqueues a normal `publish` job for
 * that document. `publish` is idempotent (see `publishing.service.ts`'s own
 * comments) — it inserts zero new events for an already-published document,
 * but its new `applySequenceGroups` pass will find these freshly-written
 * proposals and turn them into real `event_groups` rows. This script
 * therefore duplicates no group-writing logic of its own.
 */
import { Queue } from "bullmq";
import { createDataSource } from "../libs/database/src/data-source";
import {
  IngestDocument,
  IngestEventSequence,
  IngestExtraction,
} from "../libs/database/src/entities";
import { GroqExtractionEngine } from "../libs/extraction/src/groq/groq.engine";
import {
  BULLMQ_PREFIX,
  PUBLISH_JOB_OPTIONS,
  QUEUE_NAMES,
} from "../libs/queue/src/queue.constants";
import { publishJobId } from "../libs/queue/src/queue.service";
import type { ExtractedEvent } from "../../../packages/domain/src/ingestion";

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();

  const engine = new GroqExtractionEngine({
    get: (k: string) => process.env[k],
    getOrThrow: (k: string) => {
      const v = process.env[k];
      if (!v) throw new Error(`${k} is not set`);
      return v;
    },
  } as never);

  const queue = new Queue(QUEUE_NAMES.PUBLISH, {
    connection: {
      host: process.env["REDIS_HOST"] ?? "localhost",
      port: Number(process.env["REDIS_PORT"] ?? 6379),
    },
    prefix: BULLMQ_PREFIX,
  });

  try {
    const documentRepo = dataSource.getRepository(IngestDocument);
    const extractionRepo = dataSource.getRepository(IngestExtraction);
    const sequenceRepo = dataSource.getRepository(IngestEventSequence);

    const published = await documentRepo.find({
      where: { status: "published" },
    });

    for (const document of published) {
      const already = await sequenceRepo.count({
        where: { documentId: document.id },
      });
      if (already > 0) {
        console.log(`skip     ${document.title} (already has sequences)`);
        continue;
      }

      const modelRun = document.metadata["modelRun"] as string | undefined;
      const rows = await extractionRepo.find({
        where: modelRun
          ? { documentId: document.id, modelRun }
          : { documentId: document.id },
        order: { chunkIndex: "ASC" },
      });
      const events = rows.flatMap((r) => r.events as ExtractedEvent[]);
      const run = modelRun ?? rows[0]?.modelRun;

      if (events.length === 0 || !run) {
        console.log(`skip     ${document.title} (no extracted events found)`);
        continue;
      }

      const proposals = await engine.proposeSequences(
        { title: document.title ?? document.externalId },
        events.map((e) => ({
          id: e.id,
          title: e.title,
          dateText: e.dateText,
          placeName: e.placeName,
        })),
      );

      if (proposals.length === 0) {
        console.log(`none     ${document.title} (0 sequences proposed)`);
        continue;
      }

      await sequenceRepo.insert(
        proposals.map((proposal) => ({
          documentId: document.id,
          modelRun: run,
          title: proposal.title,
          description: proposal.description,
          memberEventIds: proposal.memberEventIds,
        })),
      );

      // A job with this id already ran to completion the first time this
      // document was published — BullMQ's `add()` is a no-op against an
      // existing (including completed) jobId, so without removing it first
      // this would silently resolve without ever re-running `publish()`.
      const existing = await queue.getJob(publishJobId(document.id));
      if (existing) await existing.remove();

      const job = await queue.add(
        "publish-document",
        { documentId: document.id },
        { jobId: publishJobId(document.id), ...PUBLISH_JOB_OPTIONS },
      );
      console.log(
        `queued   ${document.title} — ${proposals.length} sequence(s) ` +
          `proposed, publish job=${job.id}`,
      );
    }
  } finally {
    await queue.close();
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
