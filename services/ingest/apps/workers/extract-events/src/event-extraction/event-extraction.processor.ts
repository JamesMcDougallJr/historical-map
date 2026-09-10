import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument } from "@app/database";
import { QUEUE_NAMES, type ExtractEventsJobData } from "@app/queue";
import type { Job } from "bullmq";
import { Repository } from "typeorm";
import { EventExtractionService } from "./event-extraction.service";

/**
 * Concurrency defaults to 2 and should stay low: every concurrent job competes
 * for the same tokens-per-minute budget, and the throttle is per-process. More
 * workers do not buy throughput against a TPM ceiling, they just queue behind
 * each other inside the bucket.
 */
@Processor(QUEUE_NAMES.EXTRACT_EVENTS, {
  concurrency: Number(process.env["EXTRACT_CONCURRENCY"]) || 2,
  /**
   * BullMQ's 30s default lock is far too short here. One job extracts a whole
   * document, and on a token-limited tier a single chunk can sleep 30s honouring
   * `Retry-After` — so the job legitimately runs for many minutes. With the
   * default, stalled-job detection reclaims it mid-flight and the log fills with
   * `Missing lock for job N. moveToFinished`, which looks like corruption and is
   * really just impatience.
   */
  lockDuration: 5 * 60_000,
  stalledInterval: 5 * 60_000,
  maxStalledCount: 2,
})
export class EventExtractionProcessor extends WorkerHost {
  private readonly jobLogger = new JobLogger(EventExtractionProcessor.name);

  constructor(
    private readonly eventExtraction: EventExtractionService,
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
  ) {
    super();
  }

  async process(job: Job<ExtractEventsJobData>): Promise<void> {
    await this.eventExtraction.extract(job);
  }

  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<ExtractEventsJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await this.documentRepo.update(job.data.documentId, {
        status: "failed",
        errorMessage: error.message,
      });
      await this.jobLogger.error(
        job,
        `permanently failed after ${job.attemptsMade} attempts: ${error.message}. ` +
          `Completed chunks are checkpointed — requeue to resume.`,
      );
    }
  }
}
