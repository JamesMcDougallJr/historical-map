import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestSource } from "@app/database";
import { DETECT_JOB_OPTIONS, QUEUE_NAMES } from "@app/queue";
import { DetectionTriggerController } from "./detection-trigger.controller";

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestSource]),
    BullModule.registerQueue({
      name: QUEUE_NAMES.DETECT,
      defaultJobOptions: DETECT_JOB_OPTIONS,
    }),
  ],
  controllers: [DetectionTriggerController],
})
export class DetectionTriggerModule {}
