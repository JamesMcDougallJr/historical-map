import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { DatabaseHealthService } from "@app/database";

/**
 * `GET /health` — shared by all five apps rather than copy-pasted into each.
 *
 * Reports only what this process can actually verify: that it is up and can
 * reach Postgres. It deliberately does not check queue depth — a worker with a
 * backlog is healthy, just busy, and conflating the two makes an orchestrator
 * restart the one process that was making progress.
 */
@Controller("health")
export class HealthController {
  // Explicit @Inject, not bare constructor-param-type inference: every other
  // runtime that's ever run this app used `nest build`'s webpack+ts-loader,
  // which emits real `design:paramtypes` metadata. run-ingestion-fixture.ts
  // runs these apps directly via `tsx` instead (so the fixture test doesn't
  // need a build step first) — tsx transpiles through esbuild, whose
  // `emitDecoratorMetadata` support doesn't reliably emit that metadata for
  // a cross-file class type, so Nest resolved `databaseHealth` to `undefined`
  // with no boot-time error, only surfacing a few health polls later as
  // "Cannot read properties of undefined (reading 'isHealthy')".
  constructor(
    @Inject(DatabaseHealthService) private readonly databaseHealth: DatabaseHealthService,
  ) {}

  @Get()
  async check(): Promise<{ status: string; database: string }> {
    const databaseOk = await this.databaseHealth.isHealthy();
    if (!databaseOk) {
      throw new ServiceUnavailableException({
        status: "error",
        database: "unreachable",
      });
    }
    return { status: "ok", database: "ok" };
  }
}
