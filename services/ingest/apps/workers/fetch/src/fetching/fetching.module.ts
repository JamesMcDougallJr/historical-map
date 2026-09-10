import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument } from "@app/database";
import { ParsersModule } from "@app/parsers";
import { EXTRACT_JOB_OPTIONS, QUEUE_NAMES } from "@app/queue";
import { FetchingProcessor } from "./fetching.processor";
import { FetchingService } from "./fetching.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestDocument]),
    ParsersModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.FETCH },
      { name: QUEUE_NAMES.EXTRACT, defaultJobOptions: EXTRACT_JOB_OPTIONS },
    ),
  ],
  providers: [FetchingService, FetchingProcessor],
})
export class FetchingModule {}
