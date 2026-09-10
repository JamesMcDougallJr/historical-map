import { InitIngestSchema1757808000000 } from "./1757808000000-init-ingest-schema";
import { AddPublishTables1757894400000 } from "./1757894400000-add-publish-tables";
import { SplitTextExtraction1757980800000 } from "./1757980800000-split-text-extraction";

/**
 * Explicit imports, in order. **Do not replace this with a glob.**
 *
 * TypeORM's usual `migrations: ["dist/**\/*.js"]` pattern resolves against the
 * filesystem at runtime. `nest build` bundles every app into a single
 * `dist/main.js`, so that layout does not exist and the glob silently matches
 * nothing — migrations appear to be "already applied" and the schema never
 * changes. An explicit array is the only form that survives bundling.
 *
 * Ordering here is the execution order; TypeORM also sorts by the numeric
 * timestamp prefix, so keep the two consistent.
 */
export const INGEST_MIGRATIONS = [
  InitIngestSchema1757808000000,
  AddPublishTables1757894400000,
  SplitTextExtraction1757980800000,
];
