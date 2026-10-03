import { Module } from "@nestjs/common";
import { EXTRACTION_ENGINE } from "../tokens";
import { GroqExtractionEngine } from "./groq.engine";

/**
 * Binds the token to the Groq engine. Not `@Global()`, and it exports the
 * **token**, never the class — so nothing downstream can accidentally depend on
 * Groq specifically.
 *
 * Swapping providers is this one import line in `event-extraction.module.ts`,
 * with no change to `EventExtractionService`, the queue contract, the schema,
 * or storage. See `FakeExtractionModule` for the deterministic swap used by
 * the ingestion fixture test.
 */
@Module({
  providers: [{ provide: EXTRACTION_ENGINE, useClass: GroqExtractionEngine }],
  exports: [EXTRACTION_ENGINE],
})
export class GroqModule {}
