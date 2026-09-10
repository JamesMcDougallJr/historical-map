import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { QueueModule } from "@app/queue";
import { PublishingModule } from "./publishing/publishing.module";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule.forRoot(),
    PublishingModule,
  ],
  controllers: [HealthController],
})
export class PublishModule {}
