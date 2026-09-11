import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument } from "@app/database";
import { QUEUE_NAMES, type ValidateJobData } from "@app/queue";
import type { Job } from "bullmq";
import { Repository } from "typeorm";
import { ValidationService } from "./validation.service";

/** Pure computation over data already in hand, so concurrency is cheap. */
@Processor(QUEUE_NAMES.VALIDATE, {
  concurrency: Number(process.env["VALIDATE_CONCURRENCY"]) || 4,
})
export class ValidationProcessor extends WorkerHost {
  private readonly jobLogger = new JobLogger(ValidationProcessor.name);

  constructor(
    private readonly validation: ValidationService,
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
  ) {
    super();
  }

  async process(job: Job<ValidateJobData>): Promise<void> {
    await this.validation.validate(job);
  }

  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<ValidateJobData> | undefined,
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
