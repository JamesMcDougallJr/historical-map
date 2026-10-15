import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { DataSource } from "typeorm";
import {
  EMBEDDING_ENGINE,
  runEmbeddingSweep,
  type EmbeddingEngine,
} from "@app/embedding";

const DEFAULT_INTERVAL_MS = 60_000;

/**
 * Runs the `content_hash` sweep on a timer (plans/23, "Staleness").
 *
 * A timer, not a queue: what changes embeddings is edits in the admin app and
 * hand-edited sequences, and the web app has no queue to announce them. A pass
 * over an unchanged corpus composes and hashes a few hundred rows and makes no
 * Bedrock call, so polling is nearly free. Passes never overlap; a failed pass
 * is logged and the next one retries whatever is still stale.
 */
@Injectable()
export class EmbedSweepService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(EmbedSweepService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(EMBEDDING_ENGINE) private readonly engine: EmbeddingEngine,
  ) {}

  onApplicationBootstrap(): void {
    const interval =
      Number(process.env["EMBED_SWEEP_INTERVAL_MS"]) || DEFAULT_INTERVAL_MS;
    this.logger.log(
      `sweeping every ${interval}ms with ${this.engine.engineName} (${this.engine.model}, ${this.engine.dims} dims)`,
    );
    void this.sweepOnce();
    this.timer = setInterval(() => void this.sweepOnce(), interval);
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async sweepOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const { events, groups } = await runEmbeddingSweep(
        this.dataSource,
        this.engine,
      );
      if (events.embedded > 0 || groups.embedded > 0) {
        this.logger.log(
          `embedded ${events.embedded}/${events.checked} events, ${groups.embedded}/${groups.checked} sequences`,
        );
      }
    } catch (error) {
      this.logger.error(
        `sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
