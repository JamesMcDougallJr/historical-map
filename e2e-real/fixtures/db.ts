// Seeds the real-backend suite's fixture dataset directly via
// lib/postgres-storage.ts, bypassing HTTP so seeding doesn't need the
// webServer up yet.
import {
  ensureSchema,
  upsertEventGroup,
  upsertLocation,
  upsertSource,
  setEventGroupMembers,
} from "../../lib/postgres-storage";
import { applyMartinFunctions } from "../../scripts/apply-martin-functions";
import { FX_GROUP, FX_LOCATIONS, FX_SOURCES } from "./seed-data";
import { SEARCH_GROUP, SEARCH_LOCATIONS, SEARCH_SOURCE } from "./search-seed";

export async function seedFixtureData(): Promise<void> {
  await ensureSchema();
  await applyMartinFunctions();

  for (const source of FX_SOURCES) await upsertSource(source);
  for (const location of FX_LOCATIONS) await upsertLocation(location);

  await upsertEventGroup({ id: FX_GROUP.id, title: FX_GROUP.title, description: FX_GROUP.description });
  await setEventGroupMembers(FX_GROUP.id, FX_GROUP.memberEventIds);

  // The search corpus (search-seed.ts) — its own source, so it is its own layer.
  await upsertSource(SEARCH_SOURCE);
  for (const location of SEARCH_LOCATIONS) await upsertLocation(location);
  await upsertEventGroup({
    id: SEARCH_GROUP.id,
    title: SEARCH_GROUP.title,
    description: SEARCH_GROUP.description,
  });
  await setEventGroupMembers(SEARCH_GROUP.id, SEARCH_GROUP.memberEventIds);
}
