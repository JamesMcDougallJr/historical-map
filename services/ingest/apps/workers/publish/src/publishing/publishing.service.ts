import { Inject, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import type { ExtractedEvent, ValidationCheck } from "@historical-map/domain";
import { JobLogger } from "@app/common";
import {
  IngestDocument,
  IngestEventCandidate,
  IngestEventSequence,
  IngestSource,
  jsonb,
} from "@app/database";
import { GeocodingService } from "@app/geocoding";
import { JevClient, isJevFeatureEnabled } from "@app/jev";
import type { PublishJobData } from "@app/queue";
import type { Job } from "bullmq";
import { IsNull, Repository } from "typeorm";
import {
  judgeDuplicateWithJev,
  selectCandidates,
  type DuplicateJudgment,
} from "./jev-dedup";
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
    @InjectRepository(IngestEventSequence)
    private readonly sequenceRepo: Repository<IngestEventSequence>,
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
      let autoDuplicates = 0;

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

        // The event itself, so a same-named place can be told from the one
        // it happened at (the Jev context tier — see GeocodingService).
        const hit = await this.geocoding.resolve(event.placeName, {
          title: event.title,
          description: event.description,
        });
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
        const judgment = await this.duplicateCheck(candidate, event, hit, documentId);
        if (judgment) {
          if (judgment.outcome === "duplicate") {
            // Confidently the same event as one already on the map: resolved
            // without a person, left off the map, and recorded so one can
            // overturn it (`duplicate:review`, the admin panel).
            await this.autoResolveDuplicate(candidate, judgment.check);
            autoDuplicates++;
            continue;
          }
          if (judgment.outcome === "review") {
            await this.hold(candidate, judgment.check);
            demoted++;
            continue;
          }
          // `new`, or nothing decided (record-only): keep the evidence on the row.
          await this.recordCheck(candidate, judgment.check);
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
          significance: event.significance,
        });

        await this.candidateRepo.update(candidate.id, {
          publishedAt: new Date(),
        });
        if (inserted) published++;
        else alreadyPresent++;
      }

      const groupsApplied = await this.applySequenceGroups(documentId);
      const scoresBackfilled = await this.backfillSignificance(documentId);

      await this.documentRepo.update(documentId, {
        status: "published",
        completedAt: new Date(),
        errorMessage: null,
      });

      await this.jobLogger.log(
        job,
        `candidates=${candidates.length} published=${published} ` +
          `already-present=${alreadyPresent} demoted-to-review=${demoted} ` +
          `auto-duplicates=${autoDuplicates} ` +
          `groups=${groupsApplied} scores-backfilled=${scoresBackfilled}`,
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
   * Turns `extract-events`'s sequence proposals into real `event_groups` rows.
   *
   * A second, independent pass over **every** `verdict: "publish"` candidate
   * for this document — not just the ones this invocation just inserted —
   * because it has to see candidates published on a *previous* run too. That
   * is what makes this safe to call from the backfill script: re-enqueuing
   * `publish` for an already-published document inserts zero new events (the
   * existing loop above is unaffected) but still finds and applies any
   * `ingest_event_sequences` rows written after the fact.
   *
   * `memberEventIds` on a proposal are extraction-time ids
   * (`"{chunkIndex}-{i}"`); resolving them through this map to the id actually
   * written to `events` is what makes a proposal usable at all, and any id
   * that does not resolve (its candidate was demoted or never geocoded)
   * silently drops out of the group rather than erroring.
   */
  private async applySequenceGroups(documentId: string): Promise<number> {
    const proposals = await this.sequenceRepo.find({ where: { documentId } });
    if (proposals.length === 0) return 0;

    const published = await this.candidateRepo.find({
      where: { documentId, verdict: "publish" },
    });
    const eventKeyByExtractionId = new Map<string, string>();
    for (const candidate of published) {
      const event = candidate.event as ExtractedEvent;
      eventKeyByExtractionId.set(event.id, candidate.eventKey);
    }

    let applied = 0;
    for (const proposal of proposals) {
      const memberKeys = proposal.memberEventIds
        .map((id) => eventKeyByExtractionId.get(id))
        .filter((key): key is string => key !== undefined);
      if (memberKeys.length === 0) continue;

      const groupId = await this.mapWriter.ensureEventGroup(
        documentId,
        proposal.title,
        proposal.description,
      );
      for (const [seq, eventKey] of memberKeys.entries()) {
        await this.mapWriter.addGroupMember(groupId, eventKey, seq);
      }
      applied++;
    }
    return applied;
  }

  /**
   * Fills in `significance` for candidates whose row on the map was published
   * on a *previous* run — the main loop above only inserts/backfills for
   * candidates with `publishedAt IS NULL`, but `validate`'s `upsertCandidate`
   * deliberately never sets `publishedAt` when it re-upserts a candidate (see
   * its own docstring), so an event re-extracted with a score, whose eventKey
   * happened to match one already published before `significance` existed,
   * is invisible to that loop entirely: its candidate row already has
   * `publishedAt` set, so it is excluded from the query that feeds the loop,
   * and its fresh `event` JSON (with a real score) is never looked at again.
   *
   * Same "every verdict:publish candidate, not just this run's" shape as
   * `applySequenceGroups`, and the same reason: re-extracting to backfill
   * data onto already-published events is exactly this method's job.
   */
  private async backfillSignificance(documentId: string): Promise<number> {
    const candidates = await this.candidateRepo.find({
      where: { documentId, verdict: "publish" },
    });

    let backfilled = 0;
    for (const candidate of candidates) {
      const event = candidate.event as ExtractedEvent;
      if (event.significance == null) continue;
      await this.mapWriter.backfillSignificance(
        candidate.eventKey,
        event.significance,
      );
      backfilled++;
    }
    return backfilled;
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
  ): Promise<DuplicateJudgment | null> {
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

  /**
   * A confident duplicate: resolved (so `validate` cannot re-derive it to
   * `publish` — its upsert is `WHERE resolved_at IS NULL`), kept out of the
   * `publish` verdict, and carrying the matched event and probabilities.
   */
  private async autoResolveDuplicate(
    candidate: IngestEventCandidate,
    check: ValidationCheck,
  ): Promise<void> {
    await this.candidateRepo.update(candidate.id, {
      verdict: "review",
      resolvedAt: new Date(),
      checks: jsonb(this.withCheck(candidate.checks, check)) as never,
    });
  }

  /** Send an uncertain or probable-duplicate event to review, with Jev's reasoning on the row. */
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
