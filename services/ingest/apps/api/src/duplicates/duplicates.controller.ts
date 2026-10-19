import { InjectQueue } from "@nestjs/bullmq";
import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import type { Queue } from "bullmq";
import type { DataSource } from "typeorm";
import { listDuplicates, resolveDuplicate } from "@app/database";
import {
  JOB_NAME_BY_QUEUE,
  JOB_OPTIONS_BY_QUEUE,
  QUEUE_NAMES,
  publishJobId,
} from "@app/queue";
import type { DuplicateItem } from "@historical-map/domain";

/**
 * Events `publish` set aside as duplicates, and the verbs to resolve them.
 *
 * Unlike the rest of this app's status routes these **write** (and approving
 * re-queues a publish job), so the module mounts them behind the same fail-closed
 * Basic auth as the queue dashboard. The resolve logic is `@app/database`'s, shared
 * with `npm run duplicate:review`.
 */
@Controller("duplicates")
export class DuplicatesController {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectQueue(QUEUE_NAMES.PUBLISH) private readonly publishQueue: Queue,
  ) {}

  @Get()
  async list(): Promise<{ data: DuplicateItem[] }> {
    return { data: await listDuplicates(this.dataSource) };
  }

  @Post(":eventKey/approve")
  approve(@Param("eventKey") eventKey: string): Promise<{ ok: true }> {
    return this.resolve(eventKey, "approve");
  }

  @Post(":eventKey/dismiss")
  dismiss(@Param("eventKey") eventKey: string): Promise<{ ok: true }> {
    return this.resolve(eventKey, "dismiss");
  }

  private async resolve(eventKey: string, action: "approve" | "dismiss"): Promise<{ ok: true }> {
    const result = await resolveDuplicate(
      this.dataSource,
      eventKey,
      action,
      async (documentId) => {
        // A finished job keeps its deterministic id, and a plain add against it
        // silently no-ops — remove it first (same as `queue:requeue`).
        const jobId = publishJobId(documentId);
        await (await this.publishQueue.getJob(jobId))?.remove();
        await this.publishQueue.add(
          JOB_NAME_BY_QUEUE[QUEUE_NAMES.PUBLISH],
          { documentId },
          { jobId, ...JOB_OPTIONS_BY_QUEUE[QUEUE_NAMES.PUBLISH] },
        );
      },
    );
    if (!result.ok) {
      // Not found vs. found-but-not-allowed (dismissing an auto-resolved one).
      throw result.reason.startsWith("No held")
        ? new NotFoundException(result.reason)
        : new BadRequestException(result.reason);
    }
    return { ok: true };
  }
}
