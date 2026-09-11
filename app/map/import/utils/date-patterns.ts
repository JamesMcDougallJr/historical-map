// Date recognition moved to `packages/domain` — the ingestion `extract` worker
// uses `findDates` as a pre-filter to decide whether a chunk of text is worth
// spending a model call on, and the two must not drift apart on what counts as
// a date.
//
// Re-exported here so every existing `../date-patterns` import keeps working.
export * from "@historical-map/domain";
