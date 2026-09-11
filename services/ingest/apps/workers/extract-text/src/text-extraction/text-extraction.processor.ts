import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument } from "@app/database";
import { QUEUE_NAMES, type ExtractTextJobData } from "@app/queue";
import type { Job } from "bullmq";
import { Repository } from "typeorm";
import { TextExtractionService } from "./text-extraction.service";

/**
 * CPU-bound and free, so concurrency can be higher than the model stages — the
 * only ceiling is memory, since a large PDF is buffered whole.
 */
@Processor(QUEUE_NAMES.EXTRACT_TEXT, {
  concurrency: Number(process.env["EXTRACT_TEXT_CONCURRENCY"]) || 2,
})
export class TextExtractionProcessor extends WorkerHost {
  private readonly jobLogger = new JobLogger(TextExtractionProcessor.name);

  constructor(
    private readonly textExtraction: TextExtractionService,
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
  ) {
    super();
  }

  async process(job: Job<ExtractTextJobData>): Promise<void> {
    await this.textExtraction.extractText(job);
  }

  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<ExtractTextJobData> | undefined,
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
        `permanently failed after ${job.attemptsMade} attempts: ${error.message}`,
      );
    }
  }
}
