import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument } from "@app/database";
import {
  EXTRACT_TEXT_JOB_OPTIONS,
  QUEUE_NAMES,
  type ExtractTextJobData,
  type FetchJobData,
  extractTextJobId,
} from "@app/queue";
import {
  STORAGE_SERVICE,
  type StorageService,
  storageKeys,
} from "@app/storage";
import type { Job, Queue } from "bullmq";
import { Repository } from "typeorm";

/** Statuses meaning the original is already stored. */
const ALREADY_FETCHED = new Set([
  "fetched",
  "extracting_text",
  "text_ready",
  "extracting_events",
  "events_ready",
  "validating",
  "validated",
  "published",
]);

const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

/**
 * **Retrieval only.** Gets the bytes, stores them verbatim, and stops.
 *
 * It deliberately does not parse. Text extraction is its own stage so that
 * improving a cleaning rule re-runs over stored originals instead of
 * re-downloading — which for remote archives means not re-hitting a source that
 * rate-limits, or that has rotted since.
 */
@Injectable()
export class FetchingService {
  private readonly jobLogger = new JobLogger(FetchingService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    @InjectQueue(QUEUE_NAMES.EXTRACT_TEXT)
    private readonly textQueue: Queue<ExtractTextJobData>,
  ) {}

  async fetch(documentId: string, job: Job<FetchJobData>): Promise<void> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });
    if (!document) {
      await this.jobLogger.log(job, `document ${documentId} not found`);
      return;
    }
    if (ALREADY_FETCHED.has(document.status) && document.originalKey) {
      await this.jobLogger.log(job, `already ${document.status} — skipping`);
      return;
    }

    await this.documentRepo.update(documentId, { status: "fetching" });

    try {
      const bytes = await this.read(document);

      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        // Terminal, not retryable — it will be exactly this large next time.
        await this.documentRepo.update(documentId, {
          status: "skipped",
          errorMessage: `document is ${bytes.byteLength} bytes, over the ${MAX_DOCUMENT_BYTES} limit`,
        });
        await this.jobLogger.log(
          job,
          `too large (${bytes.byteLength}B) — skipped`,
        );
        return;
      }

      const hash = createHash("sha256").update(bytes).digest("hex");
      const key = storageKeys.original(documentId);

      // Unchanged and already stored: nothing to re-upload. Still hand off,
      // because the cleaning rules may have moved on even though the bytes
      // have not.
      const unchanged =
        document.etag === hash && (await this.storage.objectExists(key));
      if (!unchanged) {
        await this.storage.putObject(
          key,
          bytes,
          document.contentType ?? "application/octet-stream",
        );
      }

      await this.documentRepo.update(documentId, {
        status: "fetched",
        etag: hash,
        originalKey: key,
        fetchedAt: new Date(),
        errorMessage: null,
      });

      await this.jobLogger.log(
        job,
        unchanged
          ? `unchanged (hash matches, original present) — ${bytes.byteLength}B`
          : `stored ${bytes.byteLength}B at ${key}`,
      );

      await this.textQueue.add(
        "extract-text",
        { documentId },
        { jobId: extractTextJobId(documentId), ...EXTRACT_TEXT_JOB_OPTIONS },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.documentRepo.update(documentId, {
        errorMessage: message,
        fetchAttempts: () => '"fetch_attempts" + 1',
      });
      await this.jobLogger.error(job, `failed: ${message}`);
      throw error;
    }
  }

  /**
   * `file://` reads from disk. The HTTP branch is intentionally absent until a
   * remote adapter exists — SSRF guards, a redirect policy and conditional
   * requests cannot be tested without a source to exercise them, and untested
   * security code is worse than none.
   */
  private async read(document: IngestDocument): Promise<Buffer> {
    if (document.url.startsWith("file://")) {
      return readFile(fileURLToPath(document.url));
    }
    throw new Error(
      `Unsupported URL scheme for "${document.url}". Only file:// is supported ` +
        `until a remote source adapter exists.`,
    );
  }
}
