import { Injectable, Logger, type OnModuleInit } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { IngestSource } from "@app/database";
import {
  DEFAULT_DETECT_CRON,
  DETECT_JOB_OPTIONS,
  QUEUE_NAMES,
  type DetectJobData,
  detectSchedulerId,
} from "@app/queue";
import type { Queue } from "bullmq";
import { Repository } from "typeorm";

/**
 * Registers one recurring detection tick per enabled source on every boot.
 *
 * **Redis owns the schedule, not this class.** `upsertJobScheduler` overwrites
 * an entry with the same ID rather than adding a second one, so this is safe to
 * call on every restart *and* safe under multiple `detect` replicas each
 * registering independently — exactly one tick per source is produced
 * regardless of how many instances run.
 *
 * A source added or enabled after boot only gets its scheduler on the next
 * restart, which is consistent with "a new source is a new adapter plus a
 * factory line" already implying a redeploy.
 */
@Injectable()
export class DetectionSchedulerService implements OnModuleInit {
  private readonly logger = new Logger(DetectionSchedulerService.name);

  constructor(
    @InjectQueue(QUEUE_NAMES.DETECT)
    private readonly detectQueue: Queue<DetectJobData>,
    @InjectRepository(IngestSource)
    private readonly sourceRepo: Repository<IngestSource>,
  ) {}

  async onModuleInit(): Promise<void> {
    const sources = await this.sourceRepo.find({ where: { enabled: true } });

    for (const source of sources) {
      const pattern = source.pollCron ?? DEFAULT_DETECT_CRON;
      await this.detectQueue.upsertJobScheduler(
        detectSchedulerId(source.key),
        { pattern },
        {
          name: "poll-source",
          data: { sourceKey: source.key },
          opts: DETECT_JOB_OPTIONS,
        },
      );
      this.logger.log(`scheduled source=${source.key} pattern="${pattern}"`);
    }

    if (sources.length === 0) {
      this.logger.warn(
        "No enabled sources — nothing scheduled. Seed ingest_sources first.",
      );
    }
  }
}
