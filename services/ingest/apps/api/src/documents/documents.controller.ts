import { Controller, Get, Query } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import {
  IngestDocument,
  IngestReviewItem,
  type ReviewReason,
} from "@app/database";
import { Repository } from "typeorm";

/**
 * Read-only status surface. Rows here are only ever mutated by the workers, so
 * there are deliberately no write verbs — "why has nothing appeared on the map"
 * should be answerable without shell access, not fixable from a browser.
 */
@Controller()
export class DocumentsController {
  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @InjectRepository(IngestReviewItem)
    private readonly reviewRepo: Repository<IngestReviewItem>,
  ) {}

  /** Counts per pipeline status — the fastest read on overall health. */
  @Get("status")
  async status(): Promise<{
    documents: Record<string, number>;
    review: Record<string, number>;
  }> {
    const byStatus: Array<{ status: string; n: string }> =
      await this.documentRepo
        .createQueryBuilder("d")
        .select("d.status", "status")
        .addSelect("count(*)", "n")
        .groupBy("d.status")
        .getRawMany();

    const byReason: Array<{ reason: string; n: string }> = await this.reviewRepo
      .createQueryBuilder("r")
      .select("r.reason", "reason")
      .addSelect("count(*)", "n")
      .where("r.resolved_at IS NULL")
      .groupBy("r.reason")
      .getRawMany();

    return {
      documents: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
      review: Object.fromEntries(byReason.map((r) => [r.reason, Number(r.n)])),
    };
  }

  @Get("documents")
  async list(
    @Query("status") status?: string,
    @Query("limit") limit = "50",
  ): Promise<{ data: IngestDocument[]; total: number }> {
    const take = Math.min(Number(limit) || 50, 200);
    const [data, total] = await this.documentRepo.findAndCount({
      ...(status ? { where: { status: status as IngestDocument["status"] } } : {}),
      order: { detectedAt: "DESC" },
      take,
      // Documents carry their full text; a listing must not ship it.
      select: [
        "id",
        "sourceId",
        "externalId",
        "title",
        "status",
        "errorMessage",
        "fetchAttempts",
        "extractAttempts",
        "publishAttempts",
        "detectedAt",
        "completedAt",
      ],
    });
    return { data, total };
  }

  /** The human queue: events the pipeline declined to publish, and why. */
  @Get("review")
  async review(
    @Query("reason") reason?: string,
    @Query("limit") limit = "50",
  ): Promise<{ data: IngestReviewItem[]; total: number }> {
    const take = Math.min(Number(limit) || 50, 200);
    const [data, total] = await this.reviewRepo.findAndCount({
      where: {
        resolvedAt: undefined,
        ...(reason ? { reason: reason as ReviewReason } : {}),
      },
      order: { createdAt: "DESC" },
      take,
    });
    return { data, total };
  }
}
