import { Inject, Injectable } from "@nestjs/common";
import Redis from "ioredis";
import { REDIS_CLIENT } from "./ratelimit.constants";

type Source = string;
interface RateLimitContext {
  prefix: string;
  limit: number;
}

@Injectable()
export class RateLimiterService {
  private readonly rateLimits = new Map<Source, RateLimitContext>();

  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  registerRateLimit(source: Source, limit: number = 30): void {
    this.rateLimits.set(source, { prefix: source, limit });
  }

  isAllowedForSource(source: Source) {
    const context = this.rateLimits.get(source);
    if (!context) {
      throw new Error(`rate limit not registered for source "${source}"`);
    }
    const { prefix, limit } = context;
    return async (key: string): Promise<boolean> => {
      const redisKey = `${prefix}:ratelimit:${key}`;
      const count = await this.redis.incr(redisKey);
      if (count === 1) {
        await this.redis.pexpire(redisKey, 1_000);
      }
      return count <= limit;
    };
  }
}
