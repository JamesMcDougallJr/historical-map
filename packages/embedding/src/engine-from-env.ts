import { BedrockEmbeddingEngine } from "./bedrock/bedrock.engine";
import type { EmbeddingEngine } from "./embedding-engine.interface";
import { FakeEmbeddingEngine, recordedVectorsPath } from "./fake/fake.engine";
import { RecordingEmbeddingEngine } from "./fake/recording.engine";

/**
 * `EMBEDDING_ENGINE` picks the engine, the same way everywhere (the `embed`
 * worker, `search:reembed`, the fixtures):
 *
 * - `fake`    — recorded vectors only; CI and the fixtures. No AWS at all.
 * - `record`  — recorded vectors, plus live Bedrock for anything missing,
 *               written back to the file (`search:record-vectors`).
 * - otherwise — Bedrock.
 */
export function embeddingEngineFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): EmbeddingEngine {
  switch (env["EMBEDDING_ENGINE"]) {
    case "fake":
      return FakeEmbeddingEngine.fromFile();
    case "record":
      return new RecordingEmbeddingEngine(
        BedrockEmbeddingEngine.fromEnv(env),
        recordedVectorsPath(false),
      );
    default:
      return BedrockEmbeddingEngine.fromEnv(env);
  }
}
