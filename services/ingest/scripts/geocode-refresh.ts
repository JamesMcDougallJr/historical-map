/**
 * Re-resolve cached places through the current geocoder tiers.
 *
 *   npm run geocode:refresh --workspace=services/ingest                  # dry run
 *   npm run geocode:refresh --workspace=services/ingest -- --apply
 *   npm run geocode:refresh --workspace=services/ingest -- --provider=nominatim --apply
 *
 * Exists because the cache is resolve-once: a row keeps whatever the geocoder
 * said when it was written, however the tiers have improved since. Observed in
 * production: "New Spain" was cached on 2026-09-10 as "Spain Reserve, Castle
 * Hill, Sydney" — six days before the WHG geocoder merged — and every event
 * naming it was pinned in Australia.
 *
 * Only rows from `--provider` (default `nominatim`) are touched, so `manual`
 * corrections made with `geocode:review --set` always survive.
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
import type { DataSource, EntityManager } from "typeorm";
import type { RateLimiterService } from "../libs/common/src";
import { createDataSource } from "../libs/database/src/data-source";
import { GeocodeCache } from "../libs/database/src/entities";
import {
  FallbackGeocoder,
  NominatimGeocoder,
  WhgGeocoder,
  normalizePlaceName,
  type GeocodeOutcome,
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

/** Published candidates whose event names this cache row's place. */
async function publishedFrom(
  db: DataSource | EntityManager,
  normalizedName: string,
): Promise<Array<{ id: string; eventKey: string }>> {
  const rows: Array<{ id: string; event_key: string; place: string | null }> =
    await db.query(
      `SELECT id, event_key, event->>'placeName' AS place
         FROM ingest_event_candidates
        WHERE published_at IS NOT NULL`,
    );
  return rows
    .filter((r) => r.place && normalizePlaceName(r.place) === normalizedName)
    .map((r) => ({ id: r.id, eventKey: r.event_key }));
}

/**
 * Takes a place's events off the map and back to review, the way `publish`
 * demotes an event it cannot place. Locations left with no events go too.
 */
async function demote(
  tx: EntityManager,
  normalizedName: string,
  reason: string,
): Promise<number> {
  const published = await publishedFrom(tx, normalizedName);
  if (published.length === 0) return 0;

  const removed: Array<{ location_id: string }> = await tx.query(
    `DELETE FROM events WHERE id = ANY($1) RETURNING location_id`,
    [published.map((p) => p.eventKey)],
  );
  await tx.query(
    `UPDATE ingest_event_candidates
        SET verdict = 'review',
            published_at = NULL,
            checks = checks || $2::jsonb
      WHERE id = ANY($1)`,
    [
      published.map((p) => p.id),
      JSON.stringify([
        {
          name: "publish",
          passed: false,
          gating: true,
          detail: `geocode not confident: ${reason}`,
        },
      ]),
    ],
  );
  await tx.query(
    `DELETE FROM locations l
      WHERE l.id = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM events e WHERE e.location_id = l.id)`,
    [[...new Set(removed.map((r) => r.location_id))]],
  );
  return removed.length;
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
      const { hit, declined } = outcome;

      console.log(`  ${row.rawName}`);
      console.log(
        `    was ${describe(row.lat, row.lon)}  [${row.provider}] ${row.displayName ?? ""}`,
      );

      if (!hit) {
        const pins = row.found
          ? (await publishedFrom(dataSource, row.normalizedName)).length
          : 0;
        if (declined) {
          console.log(`    now NOT CONFIDENT — ${declined.reason}`);
        } else {
          console.log("    now NOT FOUND");
        }

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
              candidates: declined?.candidates.length
                ? declined.candidates
                : null,
            });
            return row.found && declined
              ? demote(tx, row.normalizedName, declined.reason)
              : 0;
          });
          if (demoted) console.log(`    demoted ${demoted} event(s)`);
        }
        console.log();
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

      await dataSource.transaction(async (tx) => {
        await tx.getRepository(GeocodeCache).update(row.id, {
          lon: hit.lon,
          lat: hit.lat,
          found: true,
          provider: hit.provider ?? geocoder.providerName,
          displayName: hit.displayName,
          candidates: hit.alternates ?? null,
        });
        if (row.found && row.lat != null && row.lon != null && !sameSpot) {
          const pins = await relocatePublishedPins(
            tx,
            { lat: row.lat, lon: row.lon },
            { lat: hit.lat, lon: hit.lon },
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
