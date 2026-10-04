import type { ConfigService } from "@nestjs/config";
import type { JevClient } from "./jev.client";

/**
 * One feature flag per Jev-backed enhancement, each independently opt-in and
 * defaulting to `false`. Jev is billed usage (even though cheap), so every
 * integration point stays off until explicitly turned on — flipping all four
 * off restores the pipeline to exactly its pre-Jev behaviour.
 */
export type JevFeatureFlag =
  | "JEV_GROUNDING_ENABLED"
  | "JEV_GEOCODE_RERANK_ENABLED"
  | "JEV_DEDUP_SCORING_ENABLED"
  | "JEV_CONFIDENCE_RESCORE_ENABLED";

/**
 * A feature is only live when both its own flag is on AND the client has
 * credentials — so turning a flag on with no `JEV_API_KEY` configured is a
 * safe no-op rather than a startup failure.
 */
export function isJevFeatureEnabled(
  config: ConfigService,
  client: JevClient,
  flag: JevFeatureFlag,
): boolean {
  return client.enabled && config.get<boolean>(flag) === true;
}
