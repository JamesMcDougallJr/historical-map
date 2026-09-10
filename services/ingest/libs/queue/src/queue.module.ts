import { BullModule } from "@nestjs/bullmq";
import { DynamicModule, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

/**
 * The Redis connection, and **no queues**.
 *
 * Each app's feature module registers the queues it actually produces to or
 * consumes from, using the shared constants. That keeps the wiring honest: you
 * can read a worker's module and see exactly which queues it touches, rather
 * than every app holding a connection to all four.
 *
 * Not imported by any app root module yet — doing so before a queue or
 * processor exists would open a live Redis connection at boot for zero
 * functional benefit.
 */
@Module({})
export class QueueModule {
  static forRoot(): DynamicModule {
    const bullRoot = BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>("REDIS_HOST"),
          port: config.get<number>("REDIS_PORT"),
        },
      }),
    });

    return {
      module: QueueModule,
      imports: [bullRoot],
      exports: [bullRoot],
    };
  }
}
