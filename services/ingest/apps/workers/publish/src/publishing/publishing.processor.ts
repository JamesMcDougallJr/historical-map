import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument } from "@app/database";
import { QUEUE_NAMES, type PublishJobData } from "@app/queue";
import type { Job } from "bullmq";
import { Repository } from "typeorm";
import { PublishingService } from "./publishing.service";

/**
 * Concurrency stays low: the geocoder is limited to roughly one request per
 * second and its throttle is per-process, so extra workers queue behind each
 * other rather than adding throughput.
 */
@Processor(QUEUE_NAMES.PUBLISH, {
  concurrency: Number(process.env["PUBLISH_CONCURRENCY"]) || 2,
})
export class PublishingProcessor extends WorkerHost {
  private readonly jobLogger = new JobLogger(PublishingProcessor.name);

  constructor(
    private readonly publishingService: PublishingService,
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
  ) {
    super();
  }

  async process(job: Job<PublishJobData>): Promise<void> {
    await this.publishingService.publish(job);
  }

  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<PublishJobData> | undefined,
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
