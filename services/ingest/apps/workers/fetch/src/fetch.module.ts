import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { QueueModule } from "@app/queue";
import { FetchingModule } from "./fetching/fetching.module";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule.forRoot(),
    FetchingModule,
  ],
  controllers: [HealthController],
})
export class FetchModule {}
