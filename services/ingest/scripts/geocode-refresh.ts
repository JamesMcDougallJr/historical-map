/**
 * Re-resolve cached places through the current geocoder tiers.
 *
 *   npm run geocode:refresh --workspace=services/ingest                  # dry run
 *   npm run geocode:refresh --workspace=services/ingest -- --apply
 *   npm run geocode:refresh --workspace=services/ingest -- --provider=nominatim --apply
 *   npm run geocode:refresh --workspace=services/ingest -- --place="tepeyacac" --apply
 *
 * Exists because the cache is resolve-once: a row keeps whatever the geocoder
 * said when it was written, however the tiers have improved since. Observed in
 * production: "New Spain" was cached on 2026-09-10 as "Spain Reserve, Castle
 * Hill, Sydney" — six days before the WHG geocoder merged — and every event
 * naming it was pinned in Australia.
 *
 * Only unreviewed rows are touched — from `--provider` (default `nominatim`),
 * or the one `--place` — so a person's `--set`, `--confirm` or `--reject`
 * always survives.
 *
 * With `JEV_GEOCODE_CONTEXT_ENABLED` and a `JEV_API_KEY`, each place is also
 * judged by the Jev context tier against an event that names it, held to the
 * `geocode.jev_context` row of `confidence_thresholds`; the decision is stored
 * for review like any made while publishing.
 *
 * What `--apply` does with each answer:
 *
 * - **a confident hit elsewhere** → the row is updated and its published pins
 *   move with it, via `relocatePublishedPins` (the path `geocode:review --set`
 *   uses).
 * - **declined** (found, but not confidently) → the row becomes a miss holding
 *   the reason, and every event published from that place leaves the map and
 *   goes back to review — a wrong pin is worse than none (plans/09: "record
 *   it rather than silently picking the first hit").
 * - **a plain miss for a place that had a hit** → kept as it is; nothing was
 *   learned that says the old answer is wrong.
 */
import type { ConfigService } from "@nestjs/config";
import type { DataSource } from "typeorm";
import type { RateLimiterService } from "../libs/common/src";
import { createDataSource } from "../libs/database/src/data-source";
import {
  GeocodeCache,
  type GeocodeDecision,
} from "../libs/database/src/entities";
import {
  JEV_CONTEXT_GEOCODE,
  demotePlace,
  getConfidenceThreshold,
  publishedFromPlace,
} from "../libs/database/src/geocodes";
import {
  FallbackGeocoder,
  NominatimGeocoder,
  WhgGeocoder,
  decideWithContext,
  normalizePlaceName,
  type GeocodeContext,
  type GeocodeHit,
  type GeocodeOutcome,
} from "../libs/geocoding/src";
import { relocatePublishedPins } from "../libs/geocoding/src/relocate";
import { JevClient, isJevFeatureEnabled } from "../libs/jev/src";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

/** Reads straight from the environment, as the workers' ConfigService does. */
function envConfig(): ConfigService {
  return {
    get: (key: string) => {
      const value = process.env[key];
      if (value === undefined || value === "") return undefined;
      if (value === "true") return true;
      if (value === "false") return false;
      const n = Number(value);
      return Number.isFinite(n) && /^\d+$/.test(value) ? n : value;
    },
  } as unknown as ConfigService;
}

/**
 * No Redis here: always defer to each geocoder's own `minIntervalMs` wait,
 * which keeps a one-off run inside both providers' usage policies.
 */
function intervalOnlyRateLimiter(): RateLimiterService {
  return {
    registerRateLimit: () => {},
    isAllowedForSource: () => async () => false,
  } as unknown as RateLimiterService;
}

function describe(lat: number | null, lon: number | null): string {
  return lat != null && lon != null
    ? `${lat.toFixed(4)}, ${lon.toFixed(4)}`
    : "NOT FOUND";
}

/** An event naming the place, published ones first — the context Jev judges in. */
async function contextFor(
  db: DataSource,
  normalizedName: string,
): Promise<GeocodeContext | undefined> {
  const rows: Array<{ title: string; description: string | null; place: string | null }> =
    await db.query(
      `SELECT event->>'title' AS title, event->>'description' AS description,
              event->>'placeName' AS place
         FROM ingest_event_candidates
        ORDER BY published_at IS NULL, created_at`,
    );
  const row = rows.find(
    (r) => r.place && normalizePlaceName(r.place) === normalizedName,
  );
  return row
    ? { title: row.title, ...(row.description ? { description: row.description } : {}) }
    : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const provider = arg("provider") ?? "nominatim";
  const place = arg("place");

  const config = envConfig();
  const rateLimiter = intervalOnlyRateLimiter();
  const jev = new JevClient(config);
  const geocoder = new FallbackGeocoder([
    new WhgGeocoder(config, rateLimiter),
    new NominatimGeocoder(config, rateLimiter, jev),
  ]);
  const useContext = isJevFeatureEnabled(config, jev, "JEV_GEOCODE_CONTEXT_ENABLED");

  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    const repo = dataSource.getRepository(GeocodeCache);
    const rows = await repo.find({
      where: place
        ? { normalizedName: normalizePlaceName(place), reviewStatus: "auto" }
        : { provider, reviewStatus: "auto" },
      order: { createdAt: "ASC" },
    });
    const threshold = await getConfidenceThreshold(dataSource, JEV_CONTEXT_GEOCODE, 0.8);
    console.log(
      `${rows.length} unreviewed ${place ? `"${place}"` : `"${provider}"`} row(s) to re-resolve` +
        (useContext ? `, with the Jev context tier at ≥ ${threshold}` : "") +
        (apply ? "" : " (dry run — pass --apply to write)") +
        "\n",
    );

    const tally = {
      moved: 0,
      newlyFound: 0,
      unchanged: 0,
      demoted: 0,
      kept: 0,
      failed: 0,
    };

    for (const row of rows) {
      let outcome: GeocodeOutcome;
      try {
        outcome = await geocoder.lookup(row.rawName);
      } catch (error) {
        tally.failed++;
        console.log(`  ${row.rawName}\n    ERROR ${String(error)}\n`);
        continue;
      }

      let hit: GeocodeHit | null = outcome.hit;
      let confidence: number | null = null;
      let decision: GeocodeDecision | null = null;
      if (useContext) {
        const context = await contextFor(dataSource, row.normalizedName);
        const decided = context
          ? await decideWithContext(jev, {
              placeName: row.rawName,
              outcome,
              context,
              threshold,
            })
          : null;
        if (decided) ({ hit, confidence, decision } = decided);
      }
      const { declined } = outcome;

      console.log(`  ${row.rawName}`);
      console.log(
        `    was ${describe(row.lat, row.lon)}  [${row.provider}] ${row.displayName ?? ""}`,
      );
      if (decision) {
        console.log(
          `    jev: picked ${decision.picked?.displayName ?? "none of these"} at ` +
            `${decision.confidence.toFixed(2)} — ${decision.applied ? "applied" : "not applied"}`,
        );
      }

      if (!hit) {
        const pins = row.found
          ? (await publishedFromPlace(dataSource, row.normalizedName, normalizePlaceName)).length
          : 0;
        console.log(
          declined ? `    now NOT CONFIDENT — ${declined.reason}` : "    now NOT FOUND",
        );

        if (row.found && !declined) {
          tally.kept++;
          console.log("    keeping the old coordinates: nothing says they are wrong\n");
          continue;
        }
        if (row.found) {
          tally.demoted++;
          console.log(`    ${pins} published event(s) go back to review`);
        } else {
          tally.unchanged++;
        }

        if (apply) {
          const demoted = await dataSource.transaction(async (tx) => {
            await tx.getRepository(GeocodeCache).update(row.id, {
              lon: null,
              lat: null,
              found: false,
              provider: geocoder.providerName,
              displayName: declined?.reason ?? null,
              candidates: declined?.candidates.length ? declined.candidates : null,
              confidence: null,
              decision,
            });
            return row.found && declined
              ? demotePlace(
                  tx,
                  row.normalizedName,
                  normalizePlaceName,
                  `geocode not confident: ${declined.reason}`,
                )
              : 0;
          });
          if (demoted) console.log(`    demoted ${demoted} event(s)`);
        }
        console.log();
        continue;
      }

      const resolved = hit;
      const sameSpot =
        row.found &&
        row.lat != null &&
        row.lon != null &&
        Math.abs(row.lat - resolved.lat) < 1e-6 &&
        Math.abs(row.lon - resolved.lon) < 1e-6;
      console.log(
        `    now ${describe(resolved.lat, resolved.lon)}  [${resolved.provider ?? "?"}] ${resolved.displayName}`,
      );

      if (sameSpot) tally.unchanged++;
      else if (row.found) tally.moved++;
      else tally.newlyFound++;

      if (!apply) {
        console.log();
        continue;
      }

      await dataSource.transaction(async (tx) => {
        await tx.getRepository(GeocodeCache).update(row.id, {
          lon: resolved.lon,
          lat: resolved.lat,
          found: true,
          provider: resolved.provider ?? geocoder.providerName,
          displayName: resolved.displayName,
          candidates: resolved.alternates ?? null,
          confidence,
          decision,
        });
        if (row.found && row.lat != null && row.lon != null && !sameSpot) {
          const pins = await relocatePublishedPins(
            tx,
            { lat: row.lat, lon: row.lon },
            { lat: resolved.lat, lon: resolved.lon },
          );
          for (const pin of pins) console.log(`    moved pin "${pin.name}" (${pin.id})`);
        }
      });
      console.log();
    }

    console.log(
      `moved=${tally.moved} newly-found=${tally.newlyFound} ` +
        `demoted=${tally.demoted} unchanged=${tally.unchanged} ` +
        `kept-old=${tally.kept} errors=${tally.failed}`,
    );
    if (tally.newlyFound > 0) {
      console.log(
        "Newly found places have no pins yet: events that failed to geocode were " +
          "demoted to review, and need re-publishing to appear.",
      );
    }
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
