import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EmbeddingError,
  type EmbeddingEngine,
} from "../embedding-engine.interface";

/** The shape of `e2e-real/fixtures/search-vectors.json`. */
export interface RecordedVectors {
  model: string;
  dims: number;
  /** Exact input text → the real vector Bedrock returned for it. */
  vectors: Record<string, number[]>;
}

const DEFAULT_RELATIVE_PATH = join(
  "e2e-real",
  "fixtures",
  "search-vectors.json",
);

/**
 * A lookup over **recorded real vectors**, not a hash (plans/19-search.md, "No
 * Bedrock in CI"). A hash-based fake can't test paraphrase matching, because
 * the whole point is that the words differ.
 *
 * Throws on any text that wasn't recorded, naming it, rather than returning a
 * made-up vector: a fixture edit without re-recording then fails loudly
 * instead of quietly testing nothing.
 *
 * `calls` and `received` exist for the specs that prove what was (not) sent:
 * typeahead never embeds, the cache saves a call, long queries are clamped.
 */
export class FakeEmbeddingEngine implements EmbeddingEngine {
  readonly engineName = "fake";
  readonly model: string;
  readonly dims: number;

  calls = 0;
  readonly received: string[] = [];

  constructor(private readonly recorded: RecordedVectors) {
    this.model = recorded.model;
    this.dims = recorded.dims;
  }

  /** Reads the file `recordedVectorsPath()` finds. */
  static fromFile(path = recordedVectorsPath()): FakeEmbeddingEngine {
    return new FakeEmbeddingEngine(
      JSON.parse(readFileSync(path, "utf8")) as RecordedVectors,
    );
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.received.push(...texts);
    return texts.map((text) => {
      const vector = this.recorded.vectors[text];
      if (!vector) {
        throw new EmbeddingError(
          `no recorded vector for ${JSON.stringify(text)} — re-record with ` +
            "`npm run search:record-vectors` after changing fixture or golden-query text",
          false,
          "NotRecorded",
        );
      }
      return vector;
    });
  }
}

/**
 * `EMBEDDING_VECTORS_FILE`, else `e2e-real/fixtures/search-vectors.json`
 * found by walking up from the working directory (the repo root for the web
 * app, `services/ingest` for the workers' scripts — and not `__dirname`, which
 * this ES module package doesn't have). `mustExist: false` is for recording,
 * which may be creating the file.
 */
export function recordedVectorsPath(mustExist = true): string {
  const fromEnv = process.env["EMBEDDING_VECTORS_FILE"];
  if (fromEnv) return fromEnv;
  try {
    return findUp(DEFAULT_RELATIVE_PATH);
  } catch (error) {
    if (mustExist) throw error;
    return join(findUp("e2e-real"), "fixtures", "search-vectors.json");
  }
}

function findUp(relative: string, start = process.cwd()): string {
  for (let dir = start; ; dir = dirname(dir)) {
    const candidate = join(dir, relative);
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) {
      throw new Error(
        `${relative} not found above ${start}; set EMBEDDING_VECTORS_FILE.`,
      );
    }
  }
}
