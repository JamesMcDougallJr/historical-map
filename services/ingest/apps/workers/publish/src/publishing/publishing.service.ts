import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import type { ExtractedEvent } from "@historical-map/domain";
import { JobLogger } from "@app/common";
import {
  IngestDocument,
  IngestEventCandidate,
  IngestEventSequence,
  IngestSource,
  jsonb,
} from "@app/database";
import { GeocodingService } from "@app/geocoding";
import type { PublishJobData } from "@app/queue";
import type { Job } from "bullmq";
import { IsNull, Repository } from "typeorm";
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

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @InjectRepository(IngestEventCandidate)
    private readonly candidateRepo: Repository<IngestEventCandidate>,
    @InjectRepository(IngestSource)
    private readonly sourceRepo: Repository<IngestSource>,
    @InjectRepository(IngestEventSequence)
    private readonly sequenceRepo: Repository<IngestEventSequence>,
    private readonly geocoding: GeocodingService,
    private readonly mapWriter: MapWriterService,
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
