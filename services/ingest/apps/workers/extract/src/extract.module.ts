import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { QueueModule } from "@app/queue";
import { ExtractingModule } from "./extracting/extracting.module";

@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule.forRoot(),
    ExtractingModule,
  ],
  controllers: [HealthController],
})
export class ExtractModule {}
