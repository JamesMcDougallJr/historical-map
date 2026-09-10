import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { ConfigService } from "@nestjs/config";
import { type ExtractedEvent, findDates } from "@historical-map/domain";
import { JobLogger } from "@app/common";
import { IngestDocument, IngestExtraction, jsonb } from "@app/database";
import type { TextSegment } from "@app/parsers";
import {
  EXTRACTION_ENGINE,
  type ExtractionChunk,
  type ExtractionEngine,
  chunkSegments,
} from "@app/extraction";
import {
  PUBLISH_JOB_OPTIONS,
  QUEUE_NAMES,
  type ExtractJobData,
  type PublishJobData,
  publishJobId,
} from "@app/queue";
import type { Job, Queue } from "bullmq";
import { Repository } from "typeorm";

/** A chunk with no date at this confidence contains no dateable event. */
const DATE_CONFIDENCE_FLOOR = 0.5;

@Injectable()
export class ExtractingService {
  private readonly jobLogger = new JobLogger(ExtractingService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @InjectRepository(IngestExtraction)
    private readonly extractionRepo: Repository<IngestExtraction>,
    @Inject(EXTRACTION_ENGINE) private readonly engine: ExtractionEngine,
    @InjectQueue(QUEUE_NAMES.PUBLISH)
    private readonly publishQueue: Queue<PublishJobData>,
    private readonly config: ConfigService,
  ) {}

  async extract(job: Job<ExtractJobData>): Promise<void> {
    const { documentId } = job.data;
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });
    if (!document) {
      await this.jobLogger.log(job, `document ${documentId} not found`);
      return;
    }
    if (document.status === "extracted" || document.status === "published") {
      await this.jobLogger.log(job, `already ${document.status} — skipping`);
      return;
    }
    if (!document.extractedText) {
      await this.jobLogger.log(job, "no text to extract from — skipping");
      return;
    }

    // Resuming an interrupted run reuses its id so completed chunks still
    // count; a fresh run gets a new one so a re-extraction under a different
    // model never collides with the old rows.
    const modelRun = job.data.modelRun ?? randomUUID();

    await this.documentRepo.update(documentId, { status: "extracting" });

    try {
      const chunks = chunkSegments(
        this.segmentsFor(document),
        this.config.get<number>("EXTRACT_CHUNK_TOKENS") ?? 3000,
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
        status: "extracted",
        extractedAt: new Date(),
        errorMessage: null,
      });

      await this.jobLogger.log(
        job,
        `chunks=${chunks.length} no-date-skipped=${skipped} events=${extracted} run=${modelRun}`,
      );

      await this.publishQueue.add(
        "publish-document",
        { documentId, modelRun },
        { jobId: publishJobId(documentId), ...PUBLISH_JOB_OPTIONS },
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

  /**
   * Segment anchors are recorded by `fetch`, but their text is not — only the
   * joined document is stored. Splitting it back on the blank line the parsers
   * join with recovers them; if the counts disagree, fall back to treating the
   * document as one segment rather than mis-attributing anchors.
   */
  private segmentsFor(document: IngestDocument): TextSegment[] {
    const anchors =
      (document.metadata["segments"] as string[] | undefined) ?? [];
    const parts = (document.extractedText ?? "").split("\n\n");

    if (anchors.length !== parts.length) {
      return [{ text: document.extractedText ?? "", anchor: "whole" }];
    }
    return parts.map((text, i) => ({ text, anchor: anchors[i] ?? `#${i}` }));
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
