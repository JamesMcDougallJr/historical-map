import { Module } from "@nestjs/common";
import { AppConfigModule, HealthController } from "@app/common";
import { DatabaseModule } from "@app/database";

/**
 * Root module for the `extract` app. AppConfigModule must come first — it is
 * `isGlobal`, and DatabaseModule's factory injects the ConfigService it
 * publishes.
 *
 * Queues, processors and feature modules are added in later phases; today this
 * boots, validates its environment, connects to Postgres, and idles.
 */
@Module({
  imports: [AppConfigModule, DatabaseModule],
  controllers: [HealthController],
})
export class ExtractModule {}
