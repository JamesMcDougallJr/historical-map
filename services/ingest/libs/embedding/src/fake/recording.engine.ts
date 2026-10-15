import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EmbeddingEngine } from "../embedding-engine.interface";
import type { RecordedVectors } from "./fake.engine";

/**
 * How `search-vectors.json` gets made: run the suites that embed with
 * `EMBEDDING_ENGINE=record` against live Bedrock, and every text they send is
 * stored with the real vector it got back. The file then holds exactly what
 * the tests embed — no hand-kept list of fixture texts to drift.
 *
 * Texts already recorded are served from the file, not re-fetched, so
 * recording is incremental and free for unchanged fixtures. Writes after
 * every call that added something, because the suites run several processes.
 */
export class RecordingEmbeddingEngine implements EmbeddingEngine {
  readonly engineName = "record";

  constructor(
    private readonly live: EmbeddingEngine,
    private readonly path: string,
  ) {}

  get model(): string {
    return this.live.model;
  }

  get dims(): number {
    return this.live.dims;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const file = this.load();
    const missing = [...new Set(texts.filter((t) => !file.vectors[t]))];
    if (missing.length > 0) {
      const vectors = await this.live.embed(missing);
      // Re-read: another process may have recorded meanwhile.
      const latest = this.load();
      missing.forEach((text, i) => {
        latest.vectors[text] = vectors[i];
      });
      const sorted = Object.fromEntries(
        Object.entries(latest.vectors).sort(([a], [b]) => a.localeCompare(b)),
      );
      writeFileSync(
        this.path,
        JSON.stringify({ ...latest, vectors: sorted }) + "\n",
      );
      Object.assign(file.vectors, latest.vectors);
    }
    return texts.map((t) => file.vectors[t]);
  }

  private load(): RecordedVectors {
    if (!existsSync(this.path)) {
      return { model: this.model, dims: this.dims, vectors: {} };
    }
    const recorded = JSON.parse(
      readFileSync(this.path, "utf8"),
    ) as RecordedVectors;
    if (recorded.model !== this.model || recorded.dims !== this.dims) {
      throw new Error(
        `${this.path} was recorded with ${recorded.model}/${recorded.dims}, ` +
          `not ${this.model}/${this.dims}. Delete it to re-record from scratch.`,
      );
    }
    return recorded;
  }
}
