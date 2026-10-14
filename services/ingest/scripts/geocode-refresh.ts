/**
 * Re-resolve cached places through the current geocoder chain (WHG first).
 *
 *   npm run geocode:refresh --workspace=services/ingest                  # dry run
 *   npm run geocode:refresh --workspace=services/ingest -- --apply
 *   npm run geocode:refresh --workspace=services/ingest -- --provider=nominatim --apply
 *
 * Exists because the cache is resolve-once: a row written before WHG was added
 * keeps its Nominatim answer forever, and WHG is never asked. Observed in
 * production: "New Spain" was cached on 2026-09-10 as "Spain Reserve, Castle
 * Hill, Sydney" — six days before the WHG geocoder merged — and every event
 * naming it was pinned in Australia.
 *
 * Only rows from `--provider` (default `nominatim`) are touched, so `manual`
 * corrections made with `geocode:review --set` always survive. A place that
 * had a hit and now gets none keeps its old coordinates: losing a pin is worse
 * than keeping a questionable one, and `geocode:review` is where that is judged.
 *
 * Published pins move with their row via `relocatePublishedPins`, the same path
 * `geocode:review --set` uses.
 */
import type { ConfigService } from "@nestjs/config";
import type { RateLimiterService } from "../libs/common/src";
import { createDataSource } from "../libs/database/src/data-source";
import { GeocodeCache } from "../libs/database/src/entities";
import {
  FallbackGeocoder,
  NominatimGeocoder,
  WhgGeocoder,
  type GeocodeHit,
} from "../libs/geocoding/src";
import { relocatePublishedPins } from "../libs/geocoding/src/relocate";
import { JevClient } from "../libs/jev/src";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

/** Reads straight from the environment, as the workers' ConfigService does. */
function envConfig(): ConfigService {
  return {
    get: (key: string) => {
      const value = process.env[key];
      if (value === undefined || value === "") return undefined;
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

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const provider = arg("provider") ?? "nominatim";

  const config = envConfig();
  const rateLimiter = intervalOnlyRateLimiter();
  const geocoder = new FallbackGeocoder([
    new WhgGeocoder(config, rateLimiter),
    new NominatimGeocoder(config, rateLimiter, new JevClient(config)),
  ]);

  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    const repo = dataSource.getRepository(GeocodeCache);
    const rows = await repo.find({
      where: { provider },
      order: { createdAt: "ASC" },
    });
    console.log(
      `${rows.length} "${provider}" row(s) to re-resolve` +
        (apply ? "" : " (dry run — pass --apply to write)") +
        "\n",
    );

    const tally = { moved: 0, unchanged: 0, newlyFound: 0, kept: 0, failed: 0 };

    for (const row of rows) {
      let hit: GeocodeHit | null;
      try {
        hit = await geocoder.geocode(row.rawName);
      } catch (error) {
        tally.failed++;
        console.log(`  ${row.rawName}\n    ERROR ${String(error)}\n`);
        continue;
      }

      const before = describe(row.lat, row.lon);
      console.log(`  ${row.rawName}`);
      console.log(`    was ${before}  [${row.provider}] ${row.displayName ?? ""}`);

      if (!hit) {
        if (row.found) {
          tally.kept++;
          console.log("    now NOT FOUND — keeping the old coordinates\n");
        } else {
          tally.unchanged++;
          console.log("    still NOT FOUND\n");
          if (apply) await repo.update(row.id, { provider: geocoder.providerName });
        }
        continue;
      }

      const sameSpot =
        row.found &&
        row.lat != null &&
        row.lon != null &&
        Math.abs(row.lat - hit.lat) < 1e-6 &&
        Math.abs(row.lon - hit.lon) < 1e-6;
      console.log(
        `    now ${describe(hit.lat, hit.lon)}  [${hit.provider ?? "?"}] ${hit.displayName}`,
      );

      if (sameSpot) tally.unchanged++;
      else if (row.found) tally.moved++;
      else tally.newlyFound++;

      if (!apply) {
        console.log();
        continue;
      }

      const resolved = hit;
      await dataSource.transaction(async (tx) => {
        await tx.getRepository(GeocodeCache).update(row.id, {
          lon: resolved.lon,
          lat: resolved.lat,
          found: true,
          provider: resolved.provider ?? geocoder.providerName,
          displayName: resolved.displayName,
          candidates: resolved.alternates ?? null,
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
        `unchanged=${tally.unchanged} kept-old=${tally.kept} errors=${tally.failed}`,
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
