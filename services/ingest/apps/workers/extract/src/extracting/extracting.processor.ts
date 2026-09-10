import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument } from "@app/database";
import { QUEUE_NAMES, type ExtractJobData } from "@app/queue";
import type { Job } from "bullmq";
import { Repository } from "typeorm";
import { ExtractingService } from "./extracting.service";

/**
 * Concurrency defaults to 2 and should stay low: every concurrent job competes
 * for the same tokens-per-minute budget, and the throttle is per-process. More
 * workers do not buy throughput against a TPM ceiling, they just queue behind
 * each other inside the bucket.
 */
@Processor(QUEUE_NAMES.EXTRACT, {
  concurrency: Number(process.env["EXTRACT_CONCURRENCY"]) || 2,
})
export class ExtractingProcessor extends WorkerHost {
  private readonly jobLogger = new JobLogger(ExtractingProcessor.name);

  constructor(
    private readonly extractingService: ExtractingService,
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
  ) {
    super();
  }

  async process(job: Job<ExtractJobData>): Promise<void> {
    await this.extractingService.extract(job);
  }

  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<ExtractJobData> | undefined,
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
