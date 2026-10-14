import { Inject, Injectable, Logger } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { GeocodeCache } from "@app/database";
import { Repository } from "typeorm";
import {
  GEOCODER,
  type GeocodeHit,
  type Geocoder,
  normalizePlaceName,
} from "./geocoder.interface";

/**
 * Cache-first geocoding.
 *
 * Every lookup checks `geocode_cache` before the provider, and **both hits and
 * misses are cached**. Caching misses matters as much as caching hits: without
 * it, an unresolvable place is re-asked on every run, spending a
 * one-per-second budget re-answering a question already answered.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(
    @Inject(GEOCODER) private readonly geocoder: Geocoder,
    @InjectRepository(GeocodeCache)
    private readonly cacheRepo: Repository<GeocodeCache>,
  ) {}

  async resolve(placeName: string): Promise<GeocodeHit | null> {
    const normalized = normalizePlaceName(placeName);
    if (!normalized) return null;

    const cached = await this.cacheRepo.findOne({
      where: { normalizedName: normalized },
    });
    if (cached) {
      if (!cached.found || cached.lon == null || cached.lat == null)
        return null;
      return {
        lon: cached.lon,
        lat: cached.lat,
        displayName: cached.displayName ?? placeName,
      };
    }

    // A throw here propagates: the provider failed, so the job should retry
    // rather than poison the cache with a miss that was never a miss.
    const { hit, declined } = this.geocoder.lookup
      ? await this.geocoder.lookup(placeName)
      : { hit: await this.geocoder.geocode(placeName), declined: undefined };

    await this.cacheRepo
      .createQueryBuilder()
      .insert()
      .into(GeocodeCache)
      .values({
        normalizedName: normalized,
        rawName: placeName,
        lon: hit?.lon ?? null,
        lat: hit?.lat ?? null,
        found: hit !== null,
        provider: hit?.provider ?? this.geocoder.providerName,
        // On a decline, why — and what was considered — is the whole review
        // item: `geocode:review` shows it, and `--set` is the human's answer.
        displayName: hit?.displayName ?? declined?.reason ?? null,
        candidates: hit
          ? hit.alternates?.length
            ? hit.alternates
            : null
          : declined?.candidates.length
            ? declined.candidates
            : null,
      })
      // A concurrent worker may have just cached the same place.
      .orIgnore()
      .execute();

    if (!hit) {
      this.logger.debug(
        declined
          ? `not confident about "${placeName}": ${declined.reason}`
          : `no match for "${placeName}"`,
      );
    }
    return hit;
  }
}
