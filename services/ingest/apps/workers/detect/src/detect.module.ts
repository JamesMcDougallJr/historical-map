import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { QueueModule } from "@app/queue";
import { DetectionModule } from "./detection/detection.module";

/**
 * Root module for the `detect` app. AppConfigModule must come first — it is
 * `isGlobal`, and both DatabaseModule and QueueModule inject the ConfigService
 * it publishes.
 *
 * This is the app that makes the system actually run: it owns the BullMQ Job
 * Scheduler registration that fires every polling tick.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule.forRoot(),
    DetectionModule,
  ],
  controllers: [HealthController],
})
export class DetectModule {}
