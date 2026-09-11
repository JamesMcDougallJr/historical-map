import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  IngestDocument,
  IngestEventCandidate,
  IngestExtraction,
  IngestSource,
} from "@app/database";
import { PUBLISH_JOB_OPTIONS, QUEUE_NAMES } from "@app/queue";
import { StorageModule } from "@app/storage";
import { ValidationProcessor } from "./validation.processor";
import { ValidationService } from "./validation.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IngestDocument,
      IngestExtraction,
      IngestEventCandidate,
      IngestSource,
    ]),
    StorageModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.VALIDATE },
      { name: QUEUE_NAMES.PUBLISH, defaultJobOptions: PUBLISH_JOB_OPTIONS },
    ),
  ],
  providers: [ValidationService, ValidationProcessor],
})
export class ValidationModule {}
