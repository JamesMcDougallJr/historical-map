import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  IngestDocument,
  IngestExtraction,
  IngestReviewItem,
  IngestSource,
} from "@app/database";
import { GeocodingModule } from "@app/geocoding";
import { QUEUE_NAMES } from "@app/queue";
import { MapWriterService } from "./map-writer.service";
import { PublishingProcessor } from "./publishing.processor";
import { PublishingService } from "./publishing.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      IngestDocument,
      IngestExtraction,
      IngestReviewItem,
      IngestSource,
    ]),
    GeocodingModule,
    // Terminal stage — consumes `publish` and produces to nothing.
    BullModule.registerQueue({ name: QUEUE_NAMES.PUBLISH }),
  ],
  providers: [PublishingService, PublishingProcessor, MapWriterService],
})
export class PublishingModule {}
