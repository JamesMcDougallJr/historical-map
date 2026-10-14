/**
 * Review and correct the geocode cache.
 *
 *   npm run geocode:review --workspace=services/ingest
 *   npm run geocode:review --workspace=services/ingest -- --set="sutters mill" --lat=38.8007 --lon=-120.8919
 *   npm run geocode:review --workspace=services/ingest -- --reject="tepeyacac"
 *   npm run geocode:review --workspace=services/ingest -- --confirm="tepeyacac"
 *
 * `--reject` is for a pin that is wrong and has no better answer to hand —
 * typically a Jev context decision (see `decideWithContext`): the place
 * becomes a miss nothing re-pins, and its events go back to review.
 * `--confirm` marks a pin right, so `geocode:refresh` leaves it alone. Both
 * share their logic with the admin panel (`@app/database`'s `reviewGeocode`).
 *
 * This exists because **Nominatim is a modern gazetteer and gets historical
 * places wrong in ways that look plausible.** Observed on the first real run:
 * "Sutter's Mill" resolved to Kuna, Idaho rather than Coloma, California, and
 * "Promontory Summit" to a ranch in Summit County rather than the Golden Spike
 * site in Box Elder County. Neither looks wrong on a map unless you know.
 *
 * Correction is cheap precisely because of the cache: a place is resolved once
 * and reused for every event that names it, so fixing one row fixes the whole
 * corpus — past and future. `--set` marks the row as manually confirmed so a
 * later run cannot overwrite it, and also moves any already-published pin that
 * sits at the row's old coordinates.
 */
import { createDataSource } from "../libs/database/src/data-source";
import { GeocodeCache } from "../libs/database/src/entities";
import { reviewGeocode } from "../libs/database/src/geocodes";
import { normalizePlaceName } from "../libs/geocoding/src/geocoder.interface";
import { relocatePublishedPins } from "../libs/geocoding/src/relocate";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    const repo = dataSource.getRepository(GeocodeCache);
    const target = arg("set");

    for (const action of ["reject", "confirm"] as const) {
      const place = arg(action);
      if (!place) continue;
      const row = await repo.findOne({
        where: { normalizedName: normalizePlaceName(place) },
      });
      if (!row) {
        console.error(`no cached geocode for "${place}"`);
        process.exitCode = 1;
        return;
      }
      const result = await dataSource.transaction((tx) =>
        reviewGeocode(tx, row.id, action, normalizePlaceName),
      );
      if (!result.ok) {
        console.error(result.reason);
        process.exitCode = 1;
        return;
      }
      console.log(
        action === "reject"
          ? `rejected "${result.placeName}": ${result.demoted} event(s) back to review`
          : `confirmed "${result.placeName}"`,
      );
      return;
    }

    if (target) {
      const lat = Number(arg("lat"));
      const lon = Number(arg("lon"));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        console.error("--set requires numeric --lat and --lon");
        process.exitCode = 1;
        return;
      }

      const normalized = normalizePlaceName(target);
      const existing = await repo.findOne({
        where: { normalizedName: normalized },
      });

      // Captured before the update: the old coordinates are how published pins
      // are found (see relocatePublishedPins).
      const previous =
        existing?.found && existing.lat != null && existing.lon != null
          ? { lat: existing.lat, lon: existing.lon }
          : null;

      if (existing) {
        await repo.update(existing.id, {
          lat,
          lon,
          found: true,
          provider: "manual",
          displayName: `${target} (manually corrected)`,
          confidence: null,
          reviewStatus: "confirmed",
          reviewedAt: new Date(),
        });
        console.log(`updated "${normalized}" -> ${lat}, ${lon}`);
      } else {
        await repo.save(
          repo.create({
            normalizedName: normalized,
            rawName: target,
            lat,
            lon,
            found: true,
            provider: "manual",
            displayName: `${target} (manually set)`,
            reviewStatus: "confirmed",
            reviewedAt: new Date(),
          }),
        );
        console.log(`created "${normalized}" -> ${lat}, ${lon}`);
      }

      if (previous) {
        const moved = await relocatePublishedPins(dataSource, previous, {
          lat,
          lon,
        });
        if (moved.length === 0) {
          console.log("no published pins were at the old coordinates");
        }
        for (const pin of moved) {
          console.log(
            `moved pin "${pin.name}" (${pin.id}) ` +
              `${previous.lat}, ${previous.lon} -> ${lat}, ${lon}`,
          );
        }
      } else {
        console.log(
          "no previous coordinates cached, so no published pin was moved",
        );
      }
      return;
    }

    const rows = await repo.find({ order: { createdAt: "ASC" } });
    if (rows.length === 0) {
      console.log("Geocode cache is empty.");
      return;
    }

    console.log(
      `${rows.length} cached place(s). Check each "matched" against what the ` +
        `document meant:\n`,
    );
    for (const row of rows) {
      const coords =
        row.found && row.lat != null && row.lon != null
          ? `${row.lat.toFixed(4)}, ${row.lon.toFixed(4)}`
          : "NOT FOUND";
      const confidence =
        row.confidence != null ? ` confidence=${row.confidence.toFixed(2)}` : "";
      const status = row.reviewStatus !== "auto" ? ` ${row.reviewStatus.toUpperCase()}` : "";
      console.log(`  ${row.rawName}`);
      console.log(`    -> ${coords}  [${row.provider ?? "?"}]${confidence}${status}`);
      if (row.displayName) console.log(`    matched: ${row.displayName}`);
      const d = row.decision;
      if (d) {
        const tier = d.tierHit ? d.tierHit.displayName : "no confident answer";
        const pick = d.picked ? d.picked.displayName : "none of these";
        console.log(
          `    ${d.method}: tiers said ${tier}; Jev picked ${pick} ` +
            `at ${d.confidence.toFixed(2)} (threshold ${d.threshold}) — ` +
            (d.applied ? "applied" : "not applied"),
        );
      }
    }
    console.log(
      `\nTo correct one:\n  npm run geocode:review --workspace=services/ingest -- \\\n` +
        `    --set="<place>" --lat=<lat> --lon=<lon>\n` +
        `To reject a wrong pin (its events go back to review):\n` +
        `  npm run geocode:review --workspace=services/ingest -- --reject="<place>"`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
