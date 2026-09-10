import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { IngestDocument, IngestExtraction } from "@app/database";
// The one line that chooses a provider. Swapping engines replaces this import
// and nothing else — ExtractingService depends only on EXTRACTION_ENGINE.
import { GroqModule } from "@app/extraction";
import { PUBLISH_JOB_OPTIONS, QUEUE_NAMES } from "@app/queue";
import { ExtractingProcessor } from "./extracting.processor";
import { ExtractingService } from "./extracting.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([IngestDocument, IngestExtraction]),
    GroqModule,
    BullModule.registerQueue(
      { name: QUEUE_NAMES.EXTRACT },
      { name: QUEUE_NAMES.PUBLISH, defaultJobOptions: PUBLISH_JOB_OPTIONS },
    ),
  ],
  providers: [ExtractingService, ExtractingProcessor],
})
export class ExtractingModule {}
