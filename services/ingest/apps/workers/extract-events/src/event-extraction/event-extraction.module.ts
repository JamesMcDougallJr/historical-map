import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument, IngestExtraction } from "@app/database";
// The provider that gets imported here. Swapping engines replaces this import
// and nothing else — EventExtractionService depends only on EXTRACTION_ENGINE.
// EXTRACTION_ENGINE=fake selects FakeExtractionModule, a deterministic
// stand-in with no network call, used by the ingestion fixture test
// (services/ingest/scripts/run-ingestion-fixture.ts).
import { FakeExtractionModule, GroqModule } from "@app/extraction";
import { QUEUE_NAMES, VALIDATE_JOB_OPTIONS } from "@app/queue";
import { StorageModule } from "@app/storage";
import { EventExtractionProcessor } from "./event-extraction.processor";
import { EventExtractionService } from "./event-extraction.service";

const ExtractionProviderModule =
  process.env["EXTRACTION_ENGINE"] === "fake" ? FakeExtractionModule : GroqModule;

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestDocument, IngestExtraction]),
    ExtractionProviderModule,
    StorageModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EXTRACT_EVENTS },
      { name: QUEUE_NAMES.VALIDATE, defaultJobOptions: VALIDATE_JOB_OPTIONS },
    ),
  ],
  providers: [EventExtractionService, EventExtractionProcessor],
})
export class EventExtractionModule {}
