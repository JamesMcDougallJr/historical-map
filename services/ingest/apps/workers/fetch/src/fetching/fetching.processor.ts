import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument } from "@app/database";
import { QUEUE_NAMES, type FetchJobData } from "@app/queue";
import type { Job } from "bullmq";
import { Repository } from "typeorm";
import { FetchingService } from "./fetching.service";

@Processor(QUEUE_NAMES.FETCH, {
  concurrency: Number(process.env["FETCH_CONCURRENCY"]) || 4,
})
export class FetchingProcessor extends WorkerHost {
  private readonly jobLogger = new JobLogger(FetchingProcessor.name);

  constructor(
    private readonly fetchingService: FetchingService,
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
  ) {
    super();
  }

  async process(job: Job<FetchJobData>): Promise<void> {
    await this.fetchingService.fetch(job.data.documentId, job);
  }

  /**
   * Flips the document to `failed` **only once BullMQ has exhausted the
   * configured attempts** — not on every transient failure. This is why the
   * processor injects the repository despite delegating everything else.
   */
  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<FetchJobData> | undefined,
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
