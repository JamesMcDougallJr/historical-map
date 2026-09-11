import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument, IngestExtraction } from "@app/database";
// The one line that chooses a provider. Swapping engines replaces this import
// and nothing else — EventExtractionService depends only on EXTRACTION_ENGINE.
import { GroqModule } from "@app/extraction";
import { QUEUE_NAMES, VALIDATE_JOB_OPTIONS } from "@app/queue";
import { StorageModule } from "@app/storage";
import { EventExtractionProcessor } from "./event-extraction.processor";
import { EventExtractionService } from "./event-extraction.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestDocument, IngestExtraction]),
    GroqModule,
    StorageModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EXTRACT_EVENTS },
      { name: QUEUE_NAMES.VALIDATE, defaultJobOptions: VALIDATE_JOB_OPTIONS },
    ),
  ],
  providers: [EventExtractionService, EventExtractionProcessor],
})
export class EventExtractionModule {}
