import { Inject, Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import type { DiscoveredDocument, SourceAdapter } from "@historical-map/domain";
import { JobLogger } from "@app/common";
import { IngestDocument, IngestSource, jsonb } from "@app/database";
import {
  FETCH_JOB_OPTIONS,
  QUEUE_NAMES,
  type DetectJobData,
  type FetchJobData,
  fetchJobId,
} from "@app/queue";
import { SOURCE_ADAPTERS } from "@app/sources";
import type { Job, Queue } from "bullmq";
import { Repository } from "typeorm";

const MS_PER_DAY = 86_400_000;

/**
 * One detection pass for exactly one source (one job = one source, so a failure
 * against one archive cannot fail the pass for any other).
 *
 * Safe to run repeatedly and concurrently. The guarantee comes from the unique
 * index on (source_id, external_id) and the `.orIgnore()` insert below — not
 * from anything in this method's control flow.
 */
@Injectable()
export class DetectionService {
  private readonly jobLogger = new JobLogger(DetectionService.name);

  constructor(
    @InjectRepository(IngestSource)
    private readonly sourceRepo: Repository<IngestSource>,
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @Inject(SOURCE_ADAPTERS) private readonly adapters: SourceAdapter[],
    @InjectQueue(QUEUE_NAMES.FETCH)
    private readonly fetchQueue: Queue<FetchJobData>,
  ) {}

  async processSource(job: Job<DetectJobData>): Promise<void> {
    // Guard against a query builder given `where: { key: undefined }`, which
    // drops the condition entirely rather than matching NULL — an unguarded
    // call would silently process whichever source the database returned
    // first. Only reachable via a stale scheduler entry or a malformed manual
    // enqueue, but the failure is silent and wrong.
    if (!job.data.sourceKey) {
      await this.jobLogger.log(
        job,
        "job.data.sourceKey missing — skipping (stale scheduler entry?)",
      );
      return;
    }

    const source = await this.sourceRepo.findOne({
      where: { key: job.data.sourceKey, enabled: true },
    });
    if (!source) {
      await this.jobLogger.log(
        job,
        `source.key="${job.data.sourceKey}" not found or disabled — skipping`,
      );
      return;
    }

    // Code/DB drift is normal during a deploy. Failing the job would burn
    // retries on a condition retrying cannot fix.
    const adapter = this.adapters.find((a) => a.key === source.key);
    if (!adapter) {
      await this.jobLogger.log(
        job,
        `no adapter registered for source.key="${source.key}" — skipping`,
      );
      return;
    }

    const known = await this.documentRepo.find({
      where: { sourceId: source.id },
      select: ["id", "externalId", "etag"],
    });
    const knownByExternalId = new Map(known.map((d) => [d.externalId, d]));

    const discovered = this.applyLookback(
      await adapter.fetchAvailableDocuments(new Set(knownByExternalId.keys())),
      job.data.lookbackDays ?? source.lookbackDays,
    );

    if (discovered.length === 0) {
      await this.jobLogger.log(job, `source=${source.key} discovered=0`);
      return;
    }

    const fresh = discovered.filter(
      (d) => !knownByExternalId.has(d.externalId),
    );
    const changed = discovered.filter((d) => {
      const existing = knownByExternalId.get(d.externalId);
      return (
        existing !== undefined && d.etag != null && existing.etag !== d.etag
      );
    });

    const insertedIds = await this.insertNew(source.id, fresh);
    for (const documentId of insertedIds) {
      await this.enqueueFetch(documentId);
    }

    // A document whose content changed (a re-saved page, an edited file) is
    // already in the table, so the insert above skipped it. Reset it to the
    // head of the pipeline explicitly.
    const changedIds = await this.markChanged(knownByExternalId, changed);
    for (const documentId of changedIds) {
      await this.enqueueFetch(documentId, { force: true });
    }

    await this.jobLogger.log(
      job,
      `source=${source.key} discovered=${discovered.length} ` +
        `new=${insertedIds.length} changed=${changedIds.length}`,
    );
  }

  /**
   * A null lookback means **no filter**, not "fall back to a default".
   *
   * The window bounds crawl volume against a large remote archive; a corpus of
   * five files on disk has no volume to bound, and every one of them has an
   * mtime of today regardless of whether the book is about 1847.
   */
  private applyLookback(
    documents: DiscoveredDocument[],
    lookbackDays: number | null | undefined,
  ): DiscoveredDocument[] {
    if (lookbackDays == null) return documents;
    const cutoff = new Date(Date.now() - lookbackDays * MS_PER_DAY);
    return documents.filter((d) => !d.publishedAt || d.publishedAt >= cutoff);
  }

  private async insertNew(
    sourceId: string,
    documents: DiscoveredDocument[],
  ): Promise<string[]> {
    if (documents.length === 0) return [];

    const result = await this.documentRepo
      .createQueryBuilder()
      .insert()
      .into(IngestDocument)
      .values(
        documents.map((d) => ({
          sourceId,
          externalId: d.externalId,
          url: d.url,
          title: d.title ?? null,
          publishedAt: d.publishedAt ?? null,
          etag: d.etag ?? null,
          contentType: d.contentType ?? null,
          metadata: jsonb(d.metadata ?? {}),
        })),
      )
      .orIgnore() // ON CONFLICT DO NOTHING — the idempotency mechanism
      .execute();

    // `identifiers` is padded with null at the position of each row the
    // conflict skipped — it is not pre-compacted. Without this filter every
    // pass would re-enqueue the entire back catalogue.
    return result.identifiers
      .filter((row): row is { id: string } => row != null)
      .map((row) => row.id);
  }

  private async markChanged(
    knownByExternalId: Map<
      string,
      Pick<IngestDocument, "id" | "externalId" | "etag">
    >,
    changed: DiscoveredDocument[],
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const document of changed) {
      const existing = knownByExternalId.get(document.externalId);
      if (!existing) continue;

      // **Deliberately does not write `etag`.** Only `fetch` may, because only
      // `fetch` turned bytes into the text the etag describes.
      //
      // Writing the new hash here looks harmless and silently breaks
      // re-ingestion: `fetch` compares the stored etag against the bytes it
      // just read, so if detection has already stored the *new* hash the two
      // match, `fetch` takes its unchanged short-circuit, and the document
      // keeps its stale text forever while every status field says success.
      await this.documentRepo.update(existing.id, {
        status: "discovered",
        errorMessage: null,
        fetchedAt: null,
        extractedAt: null,
        completedAt: null,
      });
      ids.push(existing.id);
    }
    return ids;
  }

  /**
   * `force` removes any existing job at this ID first.
   *
   * The deterministic ID makes a duplicate enqueue a silent no-op, which is
   * exactly what we want for re-detection — and exactly wrong for a document
   * we know has changed, where the old completed job would mask the new work.
   */
  private async enqueueFetch(
    documentId: string,
    options: { force?: boolean } = {},
  ): Promise<void> {
    const jobId = fetchJobId(documentId);
    if (options.force) {
      await (await this.fetchQueue.getJob(jobId))
        ?.remove()
        .catch(() => undefined);
    }
    await this.fetchQueue.add(
      "fetch-document",
      { documentId },
      { jobId, ...FETCH_JOB_OPTIONS },
    );
  }
}
