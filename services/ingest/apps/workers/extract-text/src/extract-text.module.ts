import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { QueueModule } from "@app/queue";
import { TextExtractionModule } from "./text-extraction/text-extraction.module";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule.forRoot(),
    TextExtractionModule,
  ],
  controllers: [HealthController],
})
export class ExtractTextModule {}
