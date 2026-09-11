import { OnWorkerEvent, Processor, WorkerHost } from "@nestjs/bullmq";
import { JobLogger } from "@app/common";
import { QUEUE_NAMES, type DetectJobData } from "@app/queue";
import type { Job } from "bullmq";
import { DetectionService } from "./detection.service";

/**
 * BullMQ consumer for the `detect` queue. Deliberately thin — it receives a job
 * and hands off, so the orchestration logic stays unit-testable without BullMQ
 * in the loop.
 *
 * Scheduler ticks and manual `/detection/trigger` jobs are handled identically;
 * this never distinguishes who enqueued the job.
 *
 * Concurrency is read from `process.env`, not `ConfigService`: `@Processor()`
 * options are evaluated at module-load time, before DI exists.
 */
@Processor(QUEUE_NAMES.DETECT, {
  concurrency: Number(process.env["DETECT_CONCURRENCY"]) || 1,
})
export class DetectionProcessor extends WorkerHost {
  private readonly jobLogger = new JobLogger(DetectionProcessor.name);

  constructor(private readonly detectionService: DetectionService) {
    super();
  }

  async process(job: Job<DetectJobData>): Promise<void> {
    await this.detectionService.processSource(job);
  }

  /**
   * Unlike the other stages there is no single row to flip to `failed` — a
   * detect job spans a whole source. Structured logging only, and only once
   * BullMQ has exhausted the configured attempts rather than on every
   * transient blip.
   */
  @OnWorkerEvent("failed")
  async onFailed(
    job: Job<DetectJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade >= maxAttempts) {
      await this.jobLogger.error(
        job,
        `permanently failed after ${job.attemptsMade} attempts: ${error.message}`,
      );
    }
  }
}
