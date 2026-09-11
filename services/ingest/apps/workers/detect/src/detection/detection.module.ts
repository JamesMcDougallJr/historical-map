import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument, IngestSource } from "@app/database";
import { FETCH_JOB_OPTIONS, QUEUE_NAMES } from "@app/queue";
import { SourcesModule } from "@app/sources";
import { DetectionSchedulerService } from "./detection-scheduler.service";
import { DetectionProcessor } from "./detection.processor";
import { DetectionService } from "./detection.service";

/**
 * Registers `detect` bare (this app consumes it) and `fetch` with its default
 * job options (this app only produces to it). The consumer of a queue is the
 * app that owns its retry policy at runtime; the producer supplies the options
 * at enqueue time.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([IngestSource, IngestDocument]),
    SourcesModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.DETECT },
      { name: QUEUE_NAMES.FETCH, defaultJobOptions: FETCH_JOB_OPTIONS },
    ),
  ],
  providers: [DetectionService, DetectionProcessor, DetectionSchedulerService],
})
export class DetectionModule {}
