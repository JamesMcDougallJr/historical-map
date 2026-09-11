import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument } from "@app/database";
import { EXTRACT_TEXT_JOB_OPTIONS, QUEUE_NAMES } from "@app/queue";
import { StorageModule } from "@app/storage";
import { FetchingProcessor } from "./fetching.processor";
import { FetchingService } from "./fetching.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestDocument]),
    StorageModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.FETCH },
      {
        name: QUEUE_NAMES.EXTRACT_TEXT,
        defaultJobOptions: EXTRACT_TEXT_JOB_OPTIONS,
      },
    ),
  ],
  providers: [FetchingService, FetchingProcessor],
})
export class FetchingModule {}
