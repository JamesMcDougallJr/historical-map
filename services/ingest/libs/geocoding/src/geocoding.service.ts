import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import {
  GeocodeCache,
  JEV_CONTEXT_GEOCODE,
  getConfidenceThreshold,
  type GeocodeDecision,
} from "@app/database";
import { JevClient, isJevFeatureEnabled } from "@app/jev";
import { Repository } from "typeorm";
import { decideWithContext, type GeocodeContext } from "./context";
import {
  GEOCODER,
  type GeocodeHit,
  type GeocodeOutcome,
  type Geocoder,
  normalizePlaceName,
} from "./geocoder.interface";

/** Used until the `confidence_thresholds` migration has run. */
const DEFAULT_CONTEXT_THRESHOLD = 0.8;

/**
 * Cache-first geocoding.
 *
 * Every lookup checks `geocode_cache` before the provider, and **both hits and
 * misses are cached**. Caching misses matters as much as caching hits: without
 * it, an unresolvable place is re-asked on every run, spending a
 * one-per-second budget re-answering a question already answered. A row a
 * reviewer rejected is a miss like any other, so it is never re-pinned.
 *
 * A fresh lookup runs the gazetteer tiers, then — behind
 * `JEV_GEOCODE_CONTEXT_ENABLED`, and only when the caller passes the event —
 * the Jev context tier (`decideWithContext`), held to the
 * `geocode.jev_context` row of `confidence_thresholds`. Its decision is
 * stored with the row so it can be reviewed and rejected.
 *
 * The cache is keyed on the place name, so the first event to name a place
 * is the context its decision is made in.
 */
@Injectable()
export class GeocodingService {
  private readonly logger = new Logger(GeocodingService.name);

  constructor(
    @Inject(GEOCODER) private readonly geocoder: Geocoder,
    @InjectRepository(GeocodeCache)
    private readonly cacheRepo: Repository<GeocodeCache>,
    // Explicit @Inject — see HealthController for why bare constructor-param-type
    // injection of a cross-file class silently resolves to undefined under tsx.
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(JevClient) private readonly jev: JevClient,
  ) {}

  async resolve(
    placeName: string,
    context?: GeocodeContext,
  ): Promise<GeocodeHit | null> {
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
    const outcome: GeocodeOutcome = this.geocoder.lookup
      ? await this.geocoder.lookup(placeName)
      : { hit: await this.geocoder.geocode(placeName) };

    let { hit } = outcome;
    let confidence: number | null = null;
    let decision: GeocodeDecision | null = null;
    if (
      context &&
      isJevFeatureEnabled(this.config, this.jev, "JEV_GEOCODE_CONTEXT_ENABLED")
    ) {
      const threshold = await getConfidenceThreshold(
        this.cacheRepo.manager,
        JEV_CONTEXT_GEOCODE,
        DEFAULT_CONTEXT_THRESHOLD,
      );
      const decided = await decideWithContext(this.jev, {
        placeName,
        outcome,
        context,
        threshold,
      });
      if (decided) ({ hit, confidence, decision } = decided);
    }
    const { declined } = outcome;

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
        confidence,
        decision,
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
