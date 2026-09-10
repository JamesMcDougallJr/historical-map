import { InjectQueue } from "@nestjs/bullmq";
import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Post,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { IngestSource } from "@app/database";
import {
  DETECT_JOB_OPTIONS,
  QUEUE_NAMES,
  type DetectJobData,
} from "@app/queue";
import type { Queue } from "bullmq";
import { Repository } from "typeorm";
import { TriggerDetectionDto } from "./trigger-detection.dto";

/**
 * Ad-hoc detection trigger. Producer only — the real work happens in the
 * `detect` worker, and this app has no processor.
 */
@Controller("detection")
export class DetectionTriggerController {
  constructor(
    @InjectQueue(QUEUE_NAMES.DETECT)
    private readonly detectQueue: Queue<DetectJobData>,
    @InjectRepository(IngestSource)
    private readonly sourceRepo: Repository<IngestSource>,
  ) {}

  @Post("trigger")
  @HttpCode(202)
  async trigger(
    @Body() dto: TriggerDetectionDto,
  ): Promise<{ triggered: boolean; jobIds: string[] }> {
    const sources = await this.sourceRepo.find({ where: { enabled: true } });
    let keys = sources.map((s) => s.key);

    if (dto.sourceKey) {
      if (!keys.includes(dto.sourceKey)) {
        throw new NotFoundException(
          `source "${dto.sourceKey}" not found or disabled`,
        );
      }
      keys = [dto.sourceKey];
    }

    const jobIds: string[] = [];
    for (const sourceKey of keys) {
      // Deliberately no jobId: the scheduler's per-source jobs use
      // deterministic ids, and reusing one here would make an ad-hoc trigger
      // silently collapse into the pending scheduled job instead of running.
      const job = await this.detectQueue.add(
        "poll-source",
        {
          sourceKey,
          ...(dto.lookbackDays !== undefined
            ? { lookbackDays: dto.lookbackDays }
            : {}),
        },
        DETECT_JOB_OPTIONS,
      );
      if (job.id) jobIds.push(job.id);
    }

    return { triggered: true, jobIds };
  }
}
