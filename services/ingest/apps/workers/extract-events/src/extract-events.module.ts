import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { QueueModule } from "@app/queue";
import { EventExtractionModule } from "./event-extraction/event-extraction.module";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule.forRoot(),
    EventExtractionModule,
  ],
  controllers: [HealthController],
})
export class ExtractEventsModule {}
