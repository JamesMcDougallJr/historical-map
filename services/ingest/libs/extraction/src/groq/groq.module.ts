import { Module } from "@nestjs/common";
import { EXTRACTION_ENGINE } from "../tokens";
import { GroqExtractionEngine } from "./groq.engine";

/**
 * Binds the token to the Groq engine. Not `@Global()`, and it exports the
 * **token**, never the class — so nothing downstream can accidentally depend on
 * Groq specifically.
 *
 * Swapping providers is this one import line in `extracting.module.ts`, with no
 * change to `ExtractingService`, the queue contract, the schema, or storage.
 */
@Module({
  providers: [{ provide: EXTRACTION_ENGINE, useClass: GroqExtractionEngine }],
  exports: [EXTRACTION_ENGINE],
})
export class GroqModule {}
