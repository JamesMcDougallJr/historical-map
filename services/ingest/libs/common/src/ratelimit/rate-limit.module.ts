import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { RateLimiterService } from "./rate-limiter.service";
import { REDIS_CLIENT } from "./ratelimit.constants";

@Module({
  imports: [ConfigModule],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: (config: ConfigService) =>
        new Redis({
          host: config.get<string>("REDIS_HOST"),
          port: config.get<number>("REDIS_PORT"),
        }),
      inject: [ConfigService],
    },
    RateLimiterService,
  ],
  exports: [RateLimiterService],
})
export class RateLimitModule {}
