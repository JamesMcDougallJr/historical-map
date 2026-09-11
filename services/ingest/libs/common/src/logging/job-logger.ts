import { Logger } from "@nestjs/common";
import type { Job } from "bullmq";

/**
 * Dual-transport logger for BullMQ job lifecycle steps.
 *
 * Every message goes to two places that cannot see each other:
 *   - NestJS's `Logger` → stdout → `docker logs`
 *   - BullMQ's `job.log()` → Redis → the per-job "Logs" panel in Bull Board
 *
 * Writing to only one leaves the other empty, and the per-job panel is what
 * makes "why did this document never reach the map?" answerable without
 * correlating timestamps across four containers.
 *
 * Deliberately a plain class, not an `@Injectable()` — it holds no state worth
 * sharing and is constructed as a field: `new JobLogger(FetchService.name)`.
 */
export class JobLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  async log(job: Job, message: string): Promise<void> {
    this.logger.log(`job=${job.id} ${message}`);
    await job.log(message);
  }

  async error(job: Job, message: string): Promise<void> {
    this.logger.error(`job=${job.id} ${message}`);
    await job.log(message);
  }

  /**
   * Console only — no `job` parameter, on purpose. High-volume per-chunk
   * progress would flood Redis and drown the Bull Board panel that `log()`
   * exists to keep readable.
   */
  debug(message: string): void {
    this.logger.debug(message);
  }
}
