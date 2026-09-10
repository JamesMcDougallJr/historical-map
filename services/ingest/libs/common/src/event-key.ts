import { createHash } from "node:crypto";

/**
 * Content-derived id for a published event.
 *
 * Must be deterministic: the web app's `generateEventId()` is time-plus-random,
 * so re-ingesting the same document under those ids would duplicate every event
 * rather than conflicting with it. Derived from source, document and content —
 * never from chunk position, which moves whenever the chunk budget changes.
 *
 * Lives in `common` because `validate` mints it and `publish` writes under it;
 * if the two ever disagreed, re-publishing would silently duplicate.
 */
export function eventKeyFor(
  sourceKey: string,
  externalId: string,
  title: string,
  date: string,
): string {
  const normalized = title.toLowerCase().replace(/\s+/g, " ").trim();
  const digest = createHash("sha256")
    .update(`${sourceKey} ${externalId} ${normalized} ${date}`)
    .digest("hex")
    .slice(0, 24);
  return `ev-${digest}`;
}
