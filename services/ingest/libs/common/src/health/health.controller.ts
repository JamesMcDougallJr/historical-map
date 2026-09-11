import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
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
  constructor(private readonly databaseHealth: DatabaseHealthService) {}

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
