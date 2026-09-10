import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import type { ExtractedEvent } from "@historical-map/domain";
import { JobLogger } from "@app/common";
import {
  IngestDocument,
  IngestExtraction,
  IngestReviewItem,
  IngestSource,
  type ReviewReason,
  jsonb,
} from "@app/database";
import { GeocodingService } from "@app/geocoding";
import type { PublishJobData } from "@app/queue";
import type { Job } from "bullmq";
import { Repository } from "typeorm";
import { MapWriterService, eventKeyFor } from "./map-writer.service";

@Injectable()
export class PublishingService {
  private readonly jobLogger = new JobLogger(PublishingService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @InjectRepository(IngestExtraction)
    private readonly extractionRepo: Repository<IngestExtraction>,
    @InjectRepository(IngestReviewItem)
    private readonly reviewRepo: Repository<IngestReviewItem>,
    @InjectRepository(IngestSource)
    private readonly sourceRepo: Repository<IngestSource>,
    private readonly geocoding: GeocodingService,
    private readonly mapWriter: MapWriterService,
    private readonly config: ConfigService,
  ) {}

  async publish(job: Job<PublishJobData>): Promise<void> {
    const { documentId } = job.data;

    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });
    if (!document) {
      await this.jobLogger.log(job, `document ${documentId} not found`);
      return;
    }
    if (document.status === "published") {
      await this.jobLogger.log(job, "already published — skipping");
      return;
    }

    const source = await this.sourceRepo.findOne({
      where: { id: document.sourceId },
    });
    if (!source) {
      await this.jobLogger.log(job, "source row missing — skipping");
      return;
    }

    const threshold = this.config.get<number>("PUBLISH_CONFIDENCE_MIN") ?? 0.6;

    try {
      // The map layer this source's events belong to. Without it the events
      // would have a dangling source_id and never appear under any toggle.
      await this.mapWriter.ensureSource({
        id: source.key,
        name: source.displayName,
        homepageUrl: source.homepageUrl,
        attribution: source.attribution,
      });

      const events = await this.eventsFor(documentId, job.data.modelRun);

      let published = 0;
      let duplicate = 0;
      const reviewed: Record<string, number> = {};
      const review = async (
        event: ExtractedEvent,
        key: string,
        reason: ReviewReason,
        detail?: string,
      ): Promise<void> => {
        reviewed[reason] = (reviewed[reason] ?? 0) + 1;
        await this.toReview(documentId, key, event, reason, detail);
      };

      for (const event of events) {
        // Keyed on the representative day when there is one so the id is stable
        // even if the model rewords the date text on a later run.
        const key = eventKeyFor(
          source.key,
          document.externalId,
          event.title,
          event.dateIso ?? event.dateText,
        );

        if (event.confidence < threshold) {
          await review(
            event,
            key,
            "low_confidence",
            `${event.confidence} < ${threshold}`,
          );
          continue;
        }

        // `events.date` is `date NOT NULL`, so an event with no derivable day
        // cannot be stored at all — it is kept for review rather than dropped.
        if (!event.dateIso) {
          await review(event, key, "no_date", event.dateText);
          continue;
        }

        if (!event.placeName) {
          await review(event, key, "geocode_failed", "no place named in text");
          continue;
        }

        const hit = await this.geocoding.resolve(event.placeName);
        if (!hit) {
          await review(event, key, "geocode_failed", event.placeName);
          continue;
        }

        const locationId = await this.mapWriter.findOrCreateLocation(
          event.placeName,
          hit.lon,
          hit.lat,
        );

        const inserted = await this.mapWriter.insertEvent({
          id: key,
          locationId,
          sourceId: source.key,
          title: event.title,
          date: event.dateIso,
          description: event.description,
          source: event.sourceText,
          datePrecision: event.datePrecision,
          dateText: event.dateText,
          documentId,
        });

        if (inserted) published++;
        else duplicate++;
      }

      await this.documentRepo.update(documentId, {
        status: "published",
        completedAt: new Date(),
        errorMessage: null,
      });

      const reviewSummary =
        Object.entries(reviewed)
          .map(([reason, n]) => `${reason}=${n}`)
          .join(" ") || "none";
      await this.jobLogger.log(
        job,
        `events=${events.length} published=${published} already-present=${duplicate} review: ${reviewSummary}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.documentRepo.update(documentId, {
        errorMessage: message,
        publishAttempts: () => '"publish_attempts" + 1',
      });
      await this.jobLogger.error(job, `failed: ${message}`);
      throw error;
    }
  }

  /**
   * Flattens the chunk rows of one extraction run.
   *
   * Defaults to the most recent run when the job does not name one, so a
   * re-publish after a re-extraction picks up the newer events rather than
   * replaying the superseded ones.
   */
  private async eventsFor(
    documentId: string,
    modelRun?: string,
  ): Promise<ExtractedEvent[]> {
    const rows = await this.extractionRepo.find({
      where: modelRun ? { documentId, modelRun } : { documentId },
      order: { createdAt: "DESC", chunkIndex: "ASC" },
    });
    if (rows.length === 0) return [];

    const run = modelRun ?? rows[0]?.modelRun;
    return rows
      .filter((r) => r.modelRun === run)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .flatMap((r) => r.events as ExtractedEvent[]);
  }

  private async toReview(
    documentId: string,
    eventKey: string,
    event: ExtractedEvent,
    reason: ReviewReason,
    detail?: string,
  ): Promise<void> {
    await this.reviewRepo
      .createQueryBuilder()
      .insert()
      .into(IngestReviewItem)
      .values({
        documentId,
        eventKey,
        reason,
        detail: detail ?? null,
        event: jsonb(event),
      })
      // Re-publishing the same document must not pile up review rows.
      .orIgnore()
      .execute();
  }
}
