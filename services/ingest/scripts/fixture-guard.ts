/**
 * Decides whether the ingestion fixture may reset a database.
 *
 * The fixture used to `TRUNCATE ... CASCADE` the ingest tables. `events.document_id`
 * references `ingest_documents`, and TRUNCATE ... CASCADE follows foreign keys
 * regardless of their `ON DELETE` action — so it also emptied `events` and, through
 * it, `event_group_members`. Run against a dev database that had real data, it wiped
 * every published event and sequence while the script's own header claimed it never
 * touched them.
 *
 * Two defences, both here: the reset is now scoped `DELETE`s (never CASCADE), and it
 * refuses to run at all unless everything it would remove belongs to the fixture.
 */

/** `externalId`s of the corpus files in `test-fixtures/corpus/`. */
export const FIXTURE_DOCUMENT_IDS: readonly string[] = ["fixture-one.txt", "fixture-two.txt"];

/** The source key the fixture publishes under (shared with a real local corpus!). */
export const FIXTURE_SOURCE_KEY = "local-directory";

export interface ExistingDocument {
  external_id: string;
}

/** `local-directory` events grouped by the document they came from (null = orphaned). */
export interface ExistingEvents {
  document_external_id: string | null;
  n: number;
}

/**
 * Reasons the database is not safe to reset; empty means it is.
 *
 * `local-directory` is also the source key of a real local corpus, so the source
 * alone cannot identify fixture events: an event is the fixture's only if it came
 * from a fixture document. Events whose document is gone (`document_id` set null)
 * cannot be attributed to anyone and count as foreign.
 */
export function foreignFixtureData(
  documents: ExistingDocument[],
  events: ExistingEvents[],
): string[] {
  const problems: string[] = [];
  const isFixture = (id: string | null) => id !== null && FIXTURE_DOCUMENT_IDS.includes(id);

  const foreignDocs = documents.filter((d) => !isFixture(d.external_id));
  if (foreignDocs.length > 0) {
    problems.push(
      `${foreignDocs.length} ingest_documents row(s) are not fixture documents ` +
        `(e.g. "${foreignDocs[0]!.external_id}")`,
    );
  }

  const foreignEvents = events.filter((e) => !isFixture(e.document_external_id));
  const count = foreignEvents.reduce((sum, e) => sum + e.n, 0);
  if (count > 0) {
    problems.push(
      `${count} "${FIXTURE_SOURCE_KEY}" event(s) do not come from a fixture document ` +
        `(real data, or orphaned by an earlier reset)`,
    );
  }
  return problems;
}
