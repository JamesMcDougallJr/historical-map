import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument, jsonb } from "@app/database";
import { NoParserError, ParserRegistry } from "@app/parsers";
import {
  EXTRACT_JOB_OPTIONS,
  QUEUE_NAMES,
  type ExtractJobData,
  type FetchJobData,
  extractJobId,
} from "@app/queue";
import type { Job, Queue } from "bullmq";
import { Repository } from "typeorm";

/** Statuses meaning this document is already fetched or further along. */
const ALREADY_FETCHED = new Set([
  "fetched",
  "extracting",
  "extracted",
  "published",
]);

/** Refuse to buffer more than this before parsing. */
const MAX_DOCUMENT_BYTES = 64 * 1024 * 1024;

@Injectable()
export class FetchingService {
  private readonly jobLogger = new JobLogger(FetchingService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    private readonly parsers: ParserRegistry,
    @InjectQueue(QUEUE_NAMES.EXTRACT)
    private readonly extractQueue: Queue<ExtractJobData>,
  ) {}

  async fetch(documentId: string, job: Job<FetchJobData>): Promise<void> {
    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });
    if (!document) {
      await this.jobLogger.log(
        job,
        `document ${documentId} not found — skipping`,
      );
      return;
    }

    if (ALREADY_FETCHED.has(document.status)) {
      await this.jobLogger.log(
        job,
        `already status=${document.status} — skipping`,
      );
      return;
    }

    await this.documentRepo.update(documentId, { status: "fetching" });

    try {
      const bytes = await this.read(document);

      if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
        // Terminal, not retryable — the document will be exactly this large
        // next time too.
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

      // The local analogue of a 304. If the bytes still hash to the stored
      // etag and we already have text, nothing changed and there is no work.
      const hash = createHash("sha256").update(bytes).digest("hex");
      if (document.etag === hash && document.extractedText) {
        await this.documentRepo.update(documentId, {
          status: "fetched",
          fetchedAt: new Date(),
        });
        await this.jobLogger.log(
          job,
          "unchanged (hash matches) — reusing text",
        );
        await this.enqueueExtract(documentId);
        return;
      }

      const parsed = await this.parsers.parse(
        bytes,
        document.contentType,
        document.url,
      );

      // A scanned page with no OCR layer parsed perfectly and simply has no
      // text. Retrying can never succeed, so this is terminal — conflating it
      // with a failure would burn the whole retry budget on a correct result.
      if (parsed.text.trim().length === 0) {
        await this.documentRepo.update(documentId, {
          status: "skipped",
          etag: hash,
          fetchedAt: new Date(),
          errorMessage: "no extractable text (no OCR layer?)",
        });
        await this.jobLogger.log(
          job,
          `parsed as ${parsed.kind} but empty — skipped`,
        );
        return;
      }

      await this.documentRepo.update(documentId, {
        status: "fetched",
        etag: hash,
        extractedText: parsed.text,
        fetchedAt: new Date(),
        errorMessage: null,
        metadata: jsonb({
          ...document.metadata,
          parserKind: parsed.kind,
          segments: parsed.segments.map((s) => s.anchor),
        }),
      });

      await this.jobLogger.log(
        job,
        `parsed as ${parsed.kind}: ${parsed.segments.length} segment(s), ` +
          `${parsed.text.length} chars`,
      );

      await this.enqueueExtract(documentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // No parser will ever claim this document — retrying is pointless.
      if (error instanceof NoParserError) {
        await this.documentRepo.update(documentId, {
          status: "skipped",
          errorMessage: message,
        });
        await this.jobLogger.log(job, `no parser — skipped: ${message}`);
        return;
      }

      // Increment and rethrow: BullMQ counts the attempt and retries. Only the
      // processor's `failed` handler flips status to `failed`, and only once
      // attempts are exhausted.
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
   * requests are real work that cannot be tested without a source to exercise
   * them, and untested security code is worse than none.
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

  private async enqueueExtract(documentId: string): Promise<void> {
    await this.extractQueue.add(
      "extract-document",
      { documentId },
      { jobId: extractJobId(documentId), ...EXTRACT_JOB_OPTIONS },
    );
  }
}
