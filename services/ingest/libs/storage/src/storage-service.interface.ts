/**
 * Object storage for document artifacts.
 *
 * Two things live here, and the split is the whole point of separating `fetch`
 * from `extract-text`:
 *
 *   documents/{id}/original          the exact source bytes, written once
 *   documents/{id}/text/v{N}.json    cleaned text, rewritten per extractor version
 *
 * Keeping the original is what makes re-extraction possible without going back
 * to the source — which matters because the cleaning rules will keep changing,
 * and re-hitting an archive that rate-limits (or has rotted) to apply a new
 * regex is not acceptable.
 */
export interface StorageService {
  putObject(key: string, body: Buffer, contentType?: string): Promise<void>;
  getObject(key: string): Promise<Buffer>;
  objectExists(key: string): Promise<boolean>;
}

export const STORAGE_SERVICE = "STORAGE_SERVICE";

/** Key layout, in one place so nothing constructs these by hand. */
export const storageKeys = {
  original: (documentId: string): string => `documents/${documentId}/original`,
  text: (documentId: string, version: number): string =>
    `documents/${documentId}/text/v${version}.json`,
};
