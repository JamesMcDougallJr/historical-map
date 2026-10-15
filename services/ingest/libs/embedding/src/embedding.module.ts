import { Module } from "@nestjs/common";
import { BedrockEmbeddingEngine } from "./bedrock/bedrock.engine";
import { FakeEmbeddingEngine } from "./fake/fake.engine";
import { EMBEDDING_ENGINE } from "./tokens";

/**
 * Binds `EMBEDDING_ENGINE`: the recorded-vector fake when
 * `EMBEDDING_ENGINE=fake` (CI and the ingestion fixture — no AWS credentials
 * there, deliberately), Bedrock otherwise. Exports the token, never a class.
 */
@Module({
  providers: [
    {
      provide: EMBEDDING_ENGINE,
      useFactory: () =>
        process.env["EMBEDDING_ENGINE"] === "fake"
          ? FakeEmbeddingEngine.fromFile()
          : BedrockEmbeddingEngine.fromEnv(),
    },
  ],
  exports: [EMBEDDING_ENGINE],
})
export class EmbeddingModule {}
