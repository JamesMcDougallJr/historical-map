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

export async function seedFixtureData(): Promise<void> {
  await ensureSchema();
  await applyMartinFunctions();

  for (const source of FX_SOURCES) await upsertSource(source);
  for (const location of FX_LOCATIONS) await upsertLocation(location);

  await upsertEventGroup({ id: FX_GROUP.id, title: FX_GROUP.title, description: FX_GROUP.description });
  await setEventGroupMembers(FX_GROUP.id, FX_GROUP.memberEventIds);
}
