/**
 * DI token for the configured `ExtractionEngine`.
 *
 * Its own file so `ExtractingService` can depend on the token without
 * importing any concrete engine — that indirection is the entire reason
 * swapping providers is a one-line module change rather than a refactor.
 */
export const EXTRACTION_ENGINE = "EXTRACTION_ENGINE";
