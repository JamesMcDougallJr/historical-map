import { MiddlewareConsumer, Module, NestModule } from "@nestjs/common";
import { basicAuth } from "../basic-auth.middleware";
import { GeocodesController } from "./geocodes.controller";

@Module({
  controllers: [GeocodesController],
})
export class GeocodesModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // Fails closed (503) when BULL_BOARD_PASSWORD is unset: these routes write.
    consumer
      .apply(
        basicAuth(
          process.env["BULL_BOARD_USER"] ?? "admin",
          process.env["BULL_BOARD_PASSWORD"],
        ),
      )
      .forRoutes(GeocodesController);
  }
}
