import { BullModule } from "@nestjs/bullmq";
import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { QUEUE_NAMES } from "@app/queue";
import { basicAuth } from "../basic-auth.middleware";
import { DuplicatesController } from "./duplicates.controller";

@Module({
  imports: [BullModule.registerQueue({ name: QUEUE_NAMES.PUBLISH })],
  controllers: [DuplicatesController],
})
export class DuplicatesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Fails closed (503) when BULL_BOARD_PASSWORD is unset: these routes write.
    consumer
      .apply(
        basicAuth(
          process.env["BULL_BOARD_USER"] ?? "admin",
          process.env["BULL_BOARD_PASSWORD"],
        ),
      )
      .forRoutes(DuplicatesController);
  }
}
