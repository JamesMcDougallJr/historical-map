import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { type ExtractedEvent, findDates } from "@historical-map/domain";
import { JobLogger } from "@app/common";
import { IngestDocument, IngestExtraction, jsonb } from "@app/database";
import { STORAGE_SERVICE, type StorageService } from "@app/storage";
import { type TextArtifact, parseArtifact } from "@app/parsers";
import {
  EXTRACTION_ENGINE,
  type ExtractionChunk,
  type ExtractionEngine,
  chunkSegments,
} from "@app/extraction";
import {
  QUEUE_NAMES,
  VALIDATE_JOB_OPTIONS,
  type ExtractEventsJobData,
  type ValidateJobData,
  validateJobId,
} from "@app/queue";
import type { Job, Queue } from "bullmq";
import { Repository } from "typeorm";

/** A chunk with no date at this confidence contains no dateable event. */
const DATE_CONFIDENCE_FLOOR = 0.5;

@Injectable()
export class EventExtractionService {
  private readonly jobLogger = new JobLogger(EventExtractionService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @InjectRepository(IngestExtraction)
    private readonly extractionRepo: Repository<IngestExtraction>,
    @Inject(EXTRACTION_ENGINE) private readonly engine: ExtractionEngine,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @InjectQueue(QUEUE_NAMES.VALIDATE)
    private readonly validateQueue: Queue<ValidateJobData>,
    private readonly config: ConfigService,
  ) {}

  async extract(job: Job<ExtractEventsJobData>): Promise<void> {
    const { documentId } = job.data;
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });
    if (!document) {
      await this.jobLogger.log(job, `document ${documentId} not found`);
      return;
    }
    if (["events_ready", "validated", "published"].includes(document.status)) {
      await this.jobLogger.log(job, `already ${document.status} — skipping`);
      return;
    }
    if (!document.textKey) {
      await this.jobLogger.log(
        job,
        "no text artifact — extract-text has not run",
      );
      return;
    }

    // Resuming reuses the run id so completed chunks still count; a genuinely
    // fresh run gets a new one so re-extraction never collides with old rows.
    //
    // The id is also persisted on the document, because `job.updateData` only
    // survives a *retry* of the same job. Once a job fails permanently — which
    // is exactly when a chunked 40-minute extraction is most likely to die —
    // a requeued job is a new job with empty data, and without this the whole
    // document would silently restart from chunk 0 and re-buy every chunk.
    const modelRun =
      job.data.modelRun ??
      (document.metadata["modelRun"] as string | undefined) ??
      randomUUID();

    await this.documentRepo.update(documentId, {
      status: "extracting_events",
      metadata: jsonb({ ...document.metadata, modelRun }),
    });

    try {
      // Segments come out of the stored artifact as an array. No re-splitting
      // joined text and zipping against a parallel anchor list — that round
      // trip silently collapsed a whole book into one oversized chunk whenever
      // the counts disagreed.
      const artifact: TextArtifact = parseArtifact(
        await this.storage.getObject(document.textKey),
      );
      // No `?? default` here on purpose. The env schema already defaults this
      // (to 2000) and ConfigService returns the validated value, so a fallback
      // written here can never fire — it only advertises a chunk size that is
      // not the one in use, which is exactly the sort of thing read as fact
      // when reconciling a run's chunk count against the code.
      const chunks = chunkSegments(
        artifact.segments,
        this.config.getOrThrow<number>("EXTRACT_CHUNK_TOKENS"),
      );

      const done = await this.completedChunkIndices(documentId, modelRun);
      let extracted = 0;
      let skipped = 0;

      for (const chunk of chunks) {
        if (done.has(chunk.index)) continue;

        // Cheapest possible filter, applied before anything is spent: a
        // passage with no recognisable date cannot contain a dateable event.
        // On a textbook this skips front matter, indices and bibliographies —
        // a large fraction of the pages, and the difference between a corpus
        // fitting in a free tier and not.
        if (!hasDate(chunk.text)) {
          await this.record(documentId, modelRun, chunk, []);
          skipped++;
          continue;
        }

        const events = await this.engine.extractChunk(chunk);
        // Written as each chunk succeeds, so an exhausted retry budget on
        // chunk 15 of 18 does not re-send the 14 that already worked.
        await this.record(documentId, modelRun, chunk, events);
        extracted += events.length;
      }

      await this.documentRepo.update(documentId, {
        status: "events_ready",
        extractedAt: new Date(),
        errorMessage: null,
      });

      await this.jobLogger.log(
        job,
        `chunks=${chunks.length} no-date-skipped=${skipped} events=${extracted} run=${modelRun}`,
      );

      await this.validateQueue.add(
        "validate-document",
        { documentId, modelRun },
        { jobId: validateJobId(documentId), ...VALIDATE_JOB_OPTIONS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.documentRepo.update(documentId, {
        errorMessage: message,
        extractAttempts: () => '"extract_attempts" + 1',
      });
      await this.jobLogger.error(job, `failed (run=${modelRun}): ${message}`);

      // Carry the run id forward so the retry resumes rather than restarts.
      await job.updateData({ ...job.data, modelRun });
      throw error;
    }
  }

  private async completedChunkIndices(
    documentId: string,
    modelRun: string,
  ): Promise<Set<number>> {
    const rows = await this.extractionRepo.find({
      where: { documentId, modelRun },
      select: ["chunkIndex"],
    });
    return new Set(rows.map((r) => r.chunkIndex));
  }

  private async record(
    documentId: string,
    modelRun: string,
    chunk: ExtractionChunk,
    events: ExtractedEvent[],
  ): Promise<void> {
    await this.extractionRepo
      .createQueryBuilder()
      .insert()
      .into(IngestExtraction)
      .values({
        documentId,
        modelRun,
        model: this.engine.model,
        chunkIndex: chunk.index,
        chunkCount: 1,
        events: jsonb(events),
        eventCount: events.length,
      })
      // A concurrent replica may have just written this chunk. The unique
      // index on (document_id, model_run, chunk_index) is what makes the
      // checkpoint safe; this simply declines to fight it.
      .orIgnore()
      .execute();
  }
}

function hasDate(text: string): boolean {
  return findDates(text).some((d) => d.confidence >= DATE_CONFIDENCE_FLOOR);
}
