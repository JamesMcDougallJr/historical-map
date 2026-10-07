import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";
import { JobLogger } from "@app/common";
import {
  IngestDocument,
  IngestEventCandidate,
  IngestSource,
  jsonb,
} from "@app/database";
import { GeocodingService } from "@app/geocoding";
import { JevClient, isJevFeatureEnabled } from "@app/jev";
import type { PublishJobData } from "@app/queue";
import type { Job } from "bullmq";
import { IsNull, Repository } from "typeorm";
import { judgeDuplicateWithJev, selectCandidates } from "./jev-dedup";
import { MapWriterService } from "./map-writer.service";

/**
 * Geocodes and writes. **Nothing else.**
 *
 * The confidence gate, date checks and duplicate detection all moved to
 * `validate`, so this reads only candidates already marked `publish`. That
 * split matters because judging an event and placing it are different failures:
 * a bad event should never be written, whereas a good event that cannot be
 * geocoded is still worth keeping — it just goes back to review.
 */
@Injectable()
export class PublishingService {
  private readonly jobLogger = new JobLogger(PublishingService.name);
  private readonly logger = new Logger(PublishingService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @InjectRepository(IngestEventCandidate)
    private readonly candidateRepo: Repository<IngestEventCandidate>,
    @InjectRepository(IngestSource)
    private readonly sourceRepo: Repository<IngestSource>,
    // Explicit @Inject — see HealthController for why bare constructor-param-type
    // injection of a cross-file class silently resolves to undefined under tsx.
    @Inject(GeocodingService) private readonly geocoding: GeocodingService,
    @Inject(MapWriterService) private readonly mapWriter: MapWriterService,
    @Inject(JevClient) private readonly jev: JevClient,
    @Inject(ConfigService) private readonly config: ConfigService,
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
    const source = await this.sourceRepo.findOne({
      where: { id: document.sourceId },
    });
    if (!source) {
      await this.jobLogger.log(job, "source row missing — skipping");
      return;
    }

    try {
      // The map layer this source's events belong to. Without it the events
      // would carry a dangling source_id and never appear under any toggle.
      await this.mapWriter.ensureSource({
        id: source.key,
        name: source.displayName,
        homepageUrl: source.homepageUrl,
        attribution: source.attribution,
      });

      const candidates = await this.candidateRepo.find({
        where: { documentId, verdict: "publish", publishedAt: IsNull() },
      });

      let published = 0;
      let alreadyPresent = 0;
      let demoted = 0;

      for (const candidate of candidates) {
        const event = candidate.event as ExtractedEvent;

        // `validate` guarantees these, but publishing is the last stop before
        // the map and a violated invariant here is a wrong pin, so re-check.
        if (!event.dateIso || !event.placeName) {
          await this.demote(
            candidate,
            "missing date or place after validation",
          );
          demoted++;
          continue;
        }

        const hit = await this.geocoding.resolve(event.placeName);
        if (!hit) {
          // A good event we cannot place. Back to review with its reason, not
          // discarded — `locations` requires coordinates, so it has nowhere
          // else to live.
          await this.demote(candidate, `geocode failed: ${event.placeName}`);
          demoted++;
          continue;
        }

        // Opt-in: is this the same event as one a *different* document already
        // put on the map? The only point with a coordinate and nothing written.
        const duplicate = await this.duplicateCheck(candidate, event, hit, documentId);
        if (duplicate) {
          if (duplicate.gating && !duplicate.passed) {
            await this.hold(candidate, duplicate);
            demoted++;
            continue;
          }
          // Not held (record-only, or distinct): keep the evidence on the row.
          await this.recordCheck(candidate, duplicate);
        }

        const locationId = await this.mapWriter.findOrCreateLocation(
          event.placeName,
          hit.lon,
          hit.lat,
        );

        const inserted = await this.mapWriter.insertEvent({
          id: candidate.eventKey,
          locationId,
          sourceId: source.key,
          title: event.title,
          date: event.dateIso,
          description: event.description,
          source: event.sourceText,
          datePrecision: event.datePrecision,
          dateText: event.dateText,
          documentId,
          anchor: event.anchor,
        });

        await this.candidateRepo.update(candidate.id, {
          publishedAt: new Date(),
        });
        if (inserted) published++;
        else alreadyPresent++;
      }

      await this.documentRepo.update(documentId, {
        status: "published",
        completedAt: new Date(),
        errorMessage: null,
      });

      await this.jobLogger.log(
        job,
        `candidates=${candidates.length} published=${published} ` +
          `already-present=${alreadyPresent} demoted-to-review=${demoted}`,
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
   * Cross-document duplicate check. Returns `null` (publish as normal) when the
   * flag is off, the reviewer already resolved this candidate, nothing nearby
   * is comparable, or anything at all goes wrong: it is an advisory layer, and
   * a failed lookup or an outage must never block or newly hold an event.
   */
  private async duplicateCheck(
    candidate: IngestEventCandidate,
    event: ExtractedEvent,
    hit: { lon: number; lat: number },
    documentId: string,
  ): Promise<ValidationCheck | null> {
    if (!isJevFeatureEnabled(this.config, this.jev, "JEV_PUBLISH_DEDUP_ENABLED")) return null;
    // A human approved or dismissed this one; do not second-guess them.
    if (candidate.resolvedAt) return null;
    if (!event.dateIso) return null;

    try {
      const pool = await this.mapWriter.findNearbyEvents({
        lon: hit.lon,
        lat: hit.lat,
        date: event.dateIso,
        excludeEventId: candidate.eventKey,
        excludeDocumentId: documentId,
      });
      return await judgeDuplicateWithJev(
        this.jev,
        this.config,
        event,
        selectCandidates(event, pool),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`duplicate check skipped for ${candidate.eventKey}: ${message}`);
      return null;
    }
  }

  /** `checks` with `check` in place of any earlier result of the same name. */
  private withCheck(
    checks: ValidationCheck[],
    check: ValidationCheck,
  ): ValidationCheck[] {
    return [...checks.filter((c) => c.name !== check.name), check];
  }

  private async recordCheck(
    candidate: IngestEventCandidate,
    check: ValidationCheck,
  ): Promise<void> {
    await this.candidateRepo.update(candidate.id, {
      checks: jsonb(this.withCheck(candidate.checks, check)) as never,
    });
  }

  /** Send a probable duplicate to review, with Jev's reasoning on the row. */
  private async hold(
    candidate: IngestEventCandidate,
    check: ValidationCheck,
  ): Promise<void> {
    await this.candidateRepo.update(candidate.id, {
      verdict: "review",
      checks: jsonb(this.withCheck(candidate.checks, check)) as never,
    });
  }

  /** Move a candidate back to review, recording why publishing declined it. */
  private async demote(
    candidate: IngestEventCandidate,
    detail: string,
  ): Promise<void> {
    await this.candidateRepo.update(candidate.id, {
      verdict: "review",
      checks: jsonb([
        ...candidate.checks,
        { name: "publish", passed: false, gating: true, detail },
      ]) as never,
    });
  }
}
