import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument } from "@app/database";
import { ParsersModule } from "@app/parsers";
import { EXTRACT_JOB_OPTIONS, QUEUE_NAMES } from "@app/queue";
import { StorageModule } from "@app/storage";
import { TextExtractionProcessor } from "./text-extraction.processor";
import { TextExtractionService } from "./text-extraction.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestDocument]),
    ParsersModule,
    StorageModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EXTRACT_TEXT },
      {
        name: QUEUE_NAMES.EXTRACT_EVENTS,
        defaultJobOptions: EXTRACT_JOB_OPTIONS,
      },
    ),
  ],
  providers: [TextExtractionService, TextExtractionProcessor],
})
export class TextExtractionModule {}
