import { Module } from "@nestjs/common";
import { EXTRACTION_ENGINE } from "../tokens";
import { FakeExtractionEngine } from "./fake.engine";

/**
 * Binds the token to the deterministic fake engine — mirrors `GroqModule`
 * exactly. Selected by `event-extraction.module.ts` when
 * `EXTRACTION_ENGINE=fake` (an env var, confusingly same name as the DI
 * token — the fixture runner sets it), for the ingestion fixture test.
 */
@Module({
  providers: [{ provide: EXTRACTION_ENGINE, useClass: FakeExtractionEngine }],
  exports: [EXTRACTION_ENGINE],
})
export class FakeExtractionModule {}
