/**
 * Forces a genuine re-extraction of already-published documents — not a
 * resume — so they pick up schema fields added after they were first
 * extracted (currently: `significance`, see `event-schema.ts`).
 *
 *   POSTGRES_URL=... npm run reextract-events --workspace=services/ingest
 *
 * "Genuine" requires undoing the two things that make `extract()` either
 * skip the document outright or resume from its old checkpoint instead of
 * starting fresh:
 *
 *   - `document.status` must be outside `["events_ready","validated","published"]`
 *     (`event-extraction.service.ts`'s own skip guard) — reset to `text_ready`.
 *   - `document.metadata.modelRun` must be cleared, or `extract()` reuses the
 *     old run id and `completedChunkIndices` sees every chunk as already done,
 *     silently keeping the old (pre-`significance`) rows instead of replacing
 *     them.
 *
 * Also cleans up the sequence proposals and `event_groups` the *previous* run
 * produced before re-running: a fresh `proposeSequences` call under a new
 * `modelRun` can word a similar grouping differently, and since group ids are
 * `slug(title) + hash(documentId)`, a differently-worded title would create a
 * *second*, overlapping group rather than replacing the first — the
 * "non-determinism across re-extraction" risk flagged when sequences were
 * first added, now actually happening on purpose.
 *
 * Also removes the document's existing **validate** and **publish** job ids,
 * not just extract-events' — every stage downstream re-enqueues its successor
 * with a deterministic id (`validateJobId`/`publishJobId`), and a document
 * that has already gone through the full pipeline once has a *completed* job
 * sitting under each of those ids already. `queue.add()` against an existing
 * (including completed) jobId is a silent no-op — found the hard way when
 * `extract-events` correctly re-ran but `validate` never picked up the result,
 * because its re-enqueue at the end of `extract()` no-op'd against the old
 * completed job with the same id.
 *
 * Real cost, unlike the sequence backfill: this re-sends every chunk to Groq.
 */
import { Queue } from "bullmq";
import { createDataSource } from "../libs/database/src/data-source";
import { IngestDocument, IngestEventSequence } from "../libs/database/src/entities";
import { jsonb } from "../libs/database/src/jsonb";
import { slugId } from "../apps/workers/publish/src/publishing/map-writer.service";
import {
  BULLMQ_PREFIX,
  EXTRACT_JOB_OPTIONS,
  QUEUE_NAMES,
} from "../libs/queue/src/queue.constants";
import {
  extractEventsJobId,
  publishJobId,
  validateJobId,
} from "../libs/queue/src/queue.service";

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();

  const connection = {
    host: process.env["REDIS_HOST"] ?? "localhost",
    port: Number(process.env["REDIS_PORT"] ?? 6379),
  };
  const queue = new Queue(QUEUE_NAMES.EXTRACT_EVENTS, {
    connection,
    prefix: BULLMQ_PREFIX,
  });
  const validateQueue = new Queue(QUEUE_NAMES.VALIDATE, {
    connection,
    prefix: BULLMQ_PREFIX,
  });
  const publishQueue = new Queue(QUEUE_NAMES.PUBLISH, {
    connection,
    prefix: BULLMQ_PREFIX,
  });

  try {
    const documentRepo = dataSource.getRepository(IngestDocument);
    const sequenceRepo = dataSource.getRepository(IngestEventSequence);

    const documents = await documentRepo.find({
      where: { status: "published" },
    });

    for (const document of documents) {
      // Delete the old run's sequences and whatever event_groups they
      // produced, computing each old group's id the same way
      // MapWriterService.ensureEventGroup does, so this finds exactly the
      // rows a re-run would otherwise duplicate.
      const oldSequences = await sequenceRepo.find({
        where: { documentId: document.id },
      });
      for (const seq of oldSequences) {
        const groupId = slugId(seq.title, document.id, "sequence");
        await dataSource.query(`DELETE FROM event_groups WHERE id = $1`, [
          groupId,
        ]);
      }
      await sequenceRepo.delete({ documentId: document.id });

      // Reset the document to a genuinely pre-extraction state.
      const { modelRun: _drop, ...metadata } = document.metadata as Record<
        string,
        unknown
      > & { modelRun?: string };
      await documentRepo.update(document.id, {
        status: "text_ready",
        metadata: jsonb(metadata),
        errorMessage: null,
        extractedAt: null,
        validatedAt: null,
        completedAt: null,
      });

      // A job under each of these ids already ran to completion the first
      // time — see this file's top comment. Without removing all three, the
      // pipeline can look like it is progressing (extract-events genuinely
      // re-runs) while validate/publish silently never re-fire.
      for (const [q, id] of [
        [queue, extractEventsJobId(document.id)],
        [validateQueue, validateJobId(document.id)],
        [publishQueue, publishJobId(document.id)],
      ] as const) {
        const existing = await q.getJob(id);
        if (existing) await existing.remove();
      }

      const job = await queue.add(
        "extract-events",
        { documentId: document.id },
        { jobId: extractEventsJobId(document.id), ...EXTRACT_JOB_OPTIONS },
      );
      console.log(
        `re-queued ${document.title ?? document.externalId} — ` +
          `${oldSequences.length} old sequence(s) cleared, job=${job.id}`,
      );
    }
  } finally {
    await queue.close();
    await validateQueue.close();
    await publishQueue.close();
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
