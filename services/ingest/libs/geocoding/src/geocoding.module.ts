import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { GeocodeCache } from "@app/database";
import { RateLimiterService } from "@app/common/ratelimit/rate-limiter.service";
import { RateLimitModule } from "@app/common/ratelimit/rate-limit.module";
import { FallbackGeocoder } from "./fallback.geocoder";
import { GEOCODER } from "./geocoder.interface";
import { GeocodingService } from "./geocoding.service";
import { NominatimGeocoder } from "./nominatim.geocoder";
import { WhgGeocoder } from "./whg.geocoder";

/**
 * WHG is tried first — it indexes historical place names, which Nominatim
 * (a modern gazetteer) does not — and Nominatim is the fallback for places
 * WHG's smaller (~2.2M place) index doesn't cover. Swapping the order, or
 * the providers entirely, is this one factory, with no change to
 * `PublishingService`.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeocodeCache]), RateLimitModule],
  providers: [
    {
      provide: GEOCODER,
      useFactory: (config: ConfigService, rateLimiter: RateLimiterService) =>
        new FallbackGeocoder([
          new WhgGeocoder(config, rateLimiter),
          new NominatimGeocoder(config, rateLimiter),
        ]),
      inject: [ConfigService, RateLimiterService],
    },
    GeocodingService,
  ],
  exports: [GeocodingService],
})
export class GeocodingModule {}
