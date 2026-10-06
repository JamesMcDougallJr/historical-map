import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectRepository } from "@nestjs/typeorm";
import type {
  EventVerdict,
  ExtractedEvent,
  ValidationCheck,
} from "@historical-map/domain";
import { JobLogger } from "@app/common";
import {
  IngestDocument,
  IngestEventCandidate,
  IngestExtraction,
  IngestSource,
  jsonb,
} from "@app/database";
import { artifactText, parseArtifact, type TextSegment } from "@app/parsers";
import {
  PUBLISH_JOB_OPTIONS,
  QUEUE_NAMES,
  type PublishJobData,
  type ValidateJobData,
  publishJobId,
} from "@app/queue";
import { STORAGE_SERVICE, type StorageService } from "@app/storage";
import { JevClient } from "@app/jev";
import type { Job, Queue } from "bullmq";
import { Repository } from "typeorm";
import { eventKeyFor } from "./event-key";
import { judgeEventWithJev, scoreDuplicateWithJev } from "./jev-checks";
import {
  type ValidationContext,
  checkConfidence,
  checkDatePlausible,
  checkDatePresent,
  checkDuplicate,
  checkGrounding,
  checkPlace,
  checkPrecision,
} from "./validators";

/**
 * Judges extracted events and records a verdict for each.
 *
 * Exists as its own stage because "did the model produce something we believe?"
 * is a different question from both "what did the model say?" and "where does
 * it go on the map" — and because the answer needs to be durable and
 * inspectable. Every check result is stored, including the non-gating ones, so
 * the policy can be tuned from evidence rather than intuition.
 */
@Injectable()
export class ValidationService {
  private readonly jobLogger = new JobLogger(ValidationService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @InjectRepository(IngestExtraction)
    private readonly extractionRepo: Repository<IngestExtraction>,
    @InjectRepository(IngestEventCandidate)
    private readonly candidateRepo: Repository<IngestEventCandidate>,
    @InjectRepository(IngestSource)
    private readonly sourceRepo: Repository<IngestSource>,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @InjectQueue(QUEUE_NAMES.PUBLISH)
    private readonly publishQueue: Queue<PublishJobData>,
    // Explicit @Inject — see HealthController for why bare constructor-param-type
    // injection of a cross-file class silently resolves to undefined under tsx.
    @Inject(ConfigService) private readonly config: ConfigService,
    @Inject(JevClient) private readonly jev: JevClient,
  ) {}

  async validate(job: Job<ValidateJobData>): Promise<void> {
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

    await this.documentRepo.update(documentId, { status: "validating" });

    try {
      const { events, modelRun } = await this.eventsFor(
        documentId,
        job.data.modelRun,
      );
      if (events.length === 0) {
        await this.finish(documentId, job, 0, 0, {});
        return;
      }

      // Parsed once; `segments` also feed the Jev grounding check, which
      // shows Jev the section a quote came from rather than the whole text.
      const artifact = document.textKey
        ? parseArtifact(await this.storage.getObject(document.textKey))
        : undefined;
      const context: ValidationContext = {
        documentText: artifact ? artifactText(artifact) : "",
        confidenceMin: this.config.get<number>("PUBLISH_CONFIDENCE_MIN") ?? 0.6,
        seen: new Set(),
      };

      let toPublish = 0;
      let toReview = 0;
      const reasons: Record<string, number> = {};
      // Separate from `context.seen` (exact-key `Set` for `checkDuplicate`):
      // the Jev dedup check needs full event bodies to judge, not just a key.
      const seenEvents: ExtractedEvent[] = [];

      for (const raw of events) {
        const { event, checks } = await this.runChecks(
          raw,
          context,
          seenEvents,
          artifact?.segments,
        );
        seenEvents.push(event);

        const failedGate = checks.find((c) => c.gating && !c.passed);
        const verdict: EventVerdict = failedGate ? "review" : "publish";
        if (verdict === "publish") toPublish++;
        else {
          toReview++;
          reasons[failedGate!.name] = (reasons[failedGate!.name] ?? 0) + 1;
        }

        await this.upsertCandidate(
          documentId,
          modelRun,
          eventKeyFor(
            source.key,
            document.externalId,
            event.title,
            event.dateIso ?? event.dateText,
          ),
          event,
          verdict,
          checks,
        );
      }

      await this.finish(
        documentId,
        job,
        toPublish,
        toReview,
        reasons,
        context,
        events,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.documentRepo.update(documentId, {
        errorMessage: message,
        validateAttempts: () => '"validate_attempts" + 1',
      });
      await this.jobLogger.error(job, `failed: ${message}`);
      throw error;
    }
  }

  /**
   * Runs every check, in an order where corrections happen before the checks
   * that depend on them — precision downgrades feed the date checks.
   *
   * Async because the opt-in Jev checks are real HTTP calls; the original
   * deterministic checks stay synchronous pure functions in `validators.ts`
   * and are simply awaited-for-free alongside them.
   */
  private async runChecks(
    raw: ExtractedEvent,
    context: ValidationContext,
    seenEvents: ExtractedEvent[],
    segments: TextSegment[] | undefined,
  ): Promise<{ event: ExtractedEvent; checks: ValidationCheck[] }> {
    const precision = checkPrecision(raw);
    const event = precision.corrected ?? raw;

    const substring = checkGrounding(event, context);
    const checks: ValidationCheck[] = [
      substring,
      checkConfidence(event, context),
      checkDatePresent(event),
      checkDatePlausible(event),
      precision.check,
      checkPlace(event),
      checkDuplicate(event, context),
    ];

    // Each of these is independently flagged (see `jev-checks.ts`):
    // disabled, uncredentialed, or a failed call all resolve to `null` and
    // are simply not appended, reproducing pre-Jev behaviour exactly. Only
    // `grounding-jev` can gate, and only once JEV_GROUNDING_MIN_SUPPORT is
    // raised above 0.
    // Grounding and confidence share one request (`judgeEventWithJev`);
    // duplicate detection has different state and is its own.
    const [{ grounding, confidence }, duplicate] = await Promise.all([
      judgeEventWithJev(this.jev, this.config, event, {
        documentText: context.documentText,
        segments,
        substringGrounded: substring.passed,
      }),
      scoreDuplicateWithJev(this.jev, this.config, event, seenEvents),
    ]);
    if (grounding) checks.push(grounding);
    if (duplicate) checks.push(duplicate);
    if (confidence) checks.push(confidence);

    return { event, checks };
  }

  private async finish(
    documentId: string,
    job: Job<ValidateJobData>,
    toPublish: number,
    toReview: number,
    reasons: Record<string, number>,
    context?: ValidationContext,
    events?: ExtractedEvent[],
  ): Promise<void> {
    await this.documentRepo.update(documentId, {
      status: "validated",
      validatedAt: new Date(),
      errorMessage: null,
    });

    // The grounding rate is the headline number here: the first real evidence
    // of how often the model quotes text that is not in the document.
    let grounding = "";
    if (context && events && events.length > 0) {
      const grounded = events.filter(
        (e) => checkGrounding(e, context).passed,
      ).length;
      grounding = ` grounded=${grounded}/${events.length}`;
    }

    const reasonSummary =
      Object.entries(reasons)
        .map(([name, n]) => `${name}=${n}`)
        .join(" ") || "none";

    await this.jobLogger.log(
      job,
      `publish=${toPublish} review=${toReview}${grounding} failedOn: ${reasonSummary}`,
    );

    if (toPublish > 0) {
      await this.publishQueue.add(
        "publish-document",
        { documentId },
        { jobId: publishJobId(documentId), ...PUBLISH_JOB_OPTIONS },
      );
    }
  }

  private async eventsFor(
    documentId: string,
    modelRun?: string,
  ): Promise<{ events: ExtractedEvent[]; modelRun: string }> {
    const rows = await this.extractionRepo.find({
      where: modelRun ? { documentId, modelRun } : { documentId },
      order: { createdAt: "DESC" },
    });
    const run = modelRun ?? rows[0]?.modelRun ?? "";
    const events = rows
      .filter((r) => r.modelRun === run)
      .sort((a, b) => a.chunkIndex - b.chunkIndex)
      .flatMap((r) => r.events as ExtractedEvent[]);
    return { events, modelRun: run };
  }

  /**
   * Upsert rather than insert: re-validating a document after a policy change
   * should update its verdicts, not pile up a second set of candidates.
   */
  private async upsertCandidate(
    documentId: string,
    modelRun: string,
    eventKey: string,
    event: ExtractedEvent,
    verdict: EventVerdict,
    checks: ValidationCheck[],
  ): Promise<void> {
    await this.candidateRepo
      .createQueryBuilder()
      .insert()
      .into(IngestEventCandidate)
      .values({
        documentId,
        modelRun,
        eventKey,
        verdict,
        checks: jsonb(checks),
        event: jsonb(event),
      })
      // `WHERE resolved_at IS NULL`: a reviewer who approved or dismissed a
      // candidate (see `scripts/duplicate-review.ts`) has made a decision this
      // must not overwrite — without it, re-validating a document would reset
      // an approved candidate's verdict and the duplicate check would hold it
      // again. Unresolved rows update exactly as before.
      .orUpdate(["verdict", "checks", "event", "model_run"], ["event_key"], {
        overwriteCondition: {
          where: '"ingest_event_candidates"."resolved_at" IS NULL',
        },
      })
      .execute();
  }
}
