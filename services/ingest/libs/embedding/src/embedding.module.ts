import { Module } from "@nestjs/common";
import { embeddingEngineFromEnv } from "./engine-from-env";
import { EMBEDDING_ENGINE } from "./tokens";

/**
 * Binds `EMBEDDING_ENGINE` to the engine `EMBEDDING_ENGINE` (the env var)
 * selects — see `embeddingEngineFromEnv`. Exports the token, never a class.
 */
@Module({
  providers: [
    { provide: EMBEDDING_ENGINE, useFactory: embeddingEngineFromEnv },
  ],
  exports: [EMBEDDING_ENGINE],
})
export class EmbeddingModule {}
