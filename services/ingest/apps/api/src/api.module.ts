import { BullModule } from "@nestjs/bullmq";
import { Module } from "@nestjs/common";
import { BullBoardModule } from "@bull-board/nestjs";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";
import { QUEUE_NAMES, QueueModule } from "@app/queue";
import { basicAuth } from "./basic-auth.middleware";
import { DetectionTriggerModule } from "./detection-trigger/detection-trigger.module";
import { DocumentsModule } from "./documents/documents.module";

const ALL_QUEUES = Object.values(QUEUE_NAMES);

/**
 * Operator surface: the queue dashboard, an ad-hoc detection trigger, and
 * read-only status.
 *
 * The dashboard is mounted behind HTTP Basic auth and fails closed when no
 * password is configured — it exposes every job payload and a Remove button on
 * each one.
 *
 * `fetch`/`extract`/`publish` are registered here purely for observability;
 * this app neither produces to nor consumes them. Only `detect` is a real
 * producer, and that registration lives in DetectionTriggerModule.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    QueueModule.forRoot(),
    BullBoardModule.forRoot({
      route: "/queues",
      adapter: ExpressAdapter,
      middleware: basicAuth(
        process.env["BULL_BOARD_USER"] ?? "admin",
        process.env["BULL_BOARD_PASSWORD"],
      ),
    }),
    BullModule.registerQueue(...ALL_QUEUES.map((name) => ({ name }))),
    ...ALL_QUEUES.map((name) =>
      BullBoardModule.forFeature({ name, adapter: BullMQAdapter }),
    ),
    DetectionTriggerModule,
    DocumentsModule,
  ],
  controllers: [HealthController],
})
export class ApiModule {}
