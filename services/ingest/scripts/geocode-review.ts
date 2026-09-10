/**
 * Review and correct the geocode cache.
 *
 *   npm run geocode:review --workspace=services/ingest
 *   npm run geocode:review --workspace=services/ingest -- --set="sutters mill" --lat=38.8007 --lon=-120.8919
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
 * later run cannot overwrite it.
 */
import { createDataSource } from "../libs/database/src/data-source";
import { GeocodeCache } from "../libs/database/src/entities";
import { normalizePlaceName } from "../libs/geocoding/src/geocoder.interface";

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split("=")[1];
}

async function main(): Promise<void> {
  const dataSource = createDataSource();
  await dataSource.initialize();

  try {
    const repo = dataSource.getRepository(GeocodeCache);
    const target = arg("set");

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

      if (existing) {
        await repo.update(existing.id, {
          lat,
          lon,
          found: true,
          provider: "manual",
          displayName: `${target} (manually corrected)`,
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
          }),
        );
        console.log(`created "${normalized}" -> ${lat}, ${lon}`);
      }

      console.log(
        "Note: events already published keep the old coordinates — their " +
          "location row does not move. Re-publish affected documents to " +
          "re-place them.",
      );
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
      console.log(`  ${row.rawName}`);
      console.log(`    -> ${coords}  [${row.provider ?? "?"}]`);
      if (row.displayName) console.log(`    matched: ${row.displayName}`);
    }
    console.log(
      `\nTo correct one:\n  npm run geocode:review --workspace=services/ingest -- \\\n` +
        `    --set="<place>" --lat=<lat> --lon=<lon>`,
    );
  } finally {
    await dataSource.destroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
