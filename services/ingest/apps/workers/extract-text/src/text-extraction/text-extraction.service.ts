import { InjectQueue } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { JobLogger } from "@app/common";
import { IngestDocument, jsonb } from "@app/database";
import {
  EXTRACTOR_VERSION,
  NoParserError,
  ParserRegistry,
  type TextArtifact,
  cleanDocument,
  serializeArtifact,
} from "@app/parsers";
import {
  EXTRACT_JOB_OPTIONS,
  QUEUE_NAMES,
  type ExtractEventsJobData,
  type ExtractTextJobData,
  extractEventsJobId,
} from "@app/queue";
import {
  STORAGE_SERVICE,
  type StorageService,
  storageKeys,
} from "@app/storage";
import type { Job, Queue } from "bullmq";
import { Repository } from "typeorm";

/**
 * Turns stored original bytes into a cleaned, segmented text artifact.
 *
 * The whole reason this is a separate stage: it reads the original **out of
 * object storage**, never from the source. Improving a cleaning rule is then a
 * version bump and a re-run over the corpus — no downloads, no re-hitting an
 * archive, no dependence on a URL still resolving.
 *
 * No model is involved and nothing here costs money, which is exactly why the
 * cleaning belongs on this side of the boundary: every character removed here
 * is a character not billed by the next stage.
 */
@Injectable()
export class TextExtractionService {
  private readonly jobLogger = new JobLogger(TextExtractionService.name);

  constructor(
    @InjectRepository(IngestDocument)
    private readonly documentRepo: Repository<IngestDocument>,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
    private readonly parsers: ParserRegistry,
    @InjectQueue(QUEUE_NAMES.EXTRACT_EVENTS)
    private readonly eventsQueue: Queue<ExtractEventsJobData>,
  ) {}

  async extractText(job: Job<ExtractTextJobData>): Promise<void> {
    const { documentId, force } = job.data;

    const document = await this.documentRepo.findOne({
      where: { id: documentId },
    });
    if (!document) {
      await this.jobLogger.log(job, `document ${documentId} not found`);
      return;
    }
    if (!document.originalKey) {
      await this.jobLogger.log(job, "no stored original — fetch has not run");
      return;
    }

    // Already cleaned by the current ruleset. A version bump is what makes this
    // stop being true, which is how a cleaning change rolls out.
    if (
      !force &&
      document.textExtractorVersion === EXTRACTOR_VERSION &&
      document.textKey
    ) {
      await this.jobLogger.log(
        job,
        `already extracted at v${EXTRACTOR_VERSION} — skipping`,
      );
      await this.enqueueEvents(documentId);
      return;
    }

    await this.documentRepo.update(documentId, { status: "extracting_text" });

    try {
      const bytes = await this.storage.getObject(document.originalKey);
      const parsed = await this.parsers.parse(
        bytes,
        document.contentType,
        document.url,
      );
      const cleaned = cleanDocument(parsed);

      // A scan with no OCR layer parsed correctly and simply has no text.
      // Retrying can never succeed, so this is terminal — conflating it with
      // failure would burn the retry budget on a correct result.
      if (cleaned.text.trim().length === 0) {
        await this.documentRepo.update(documentId, {
          status: "skipped",
          errorMessage: "no extractable text (no OCR layer?)",
        });
        await this.jobLogger.log(
          job,
          `parsed as ${parsed.kind} but empty — skipped`,
        );
        return;
      }

      const artifact: TextArtifact = {
        extractorVersion: EXTRACTOR_VERSION,
        kind: parsed.kind as TextArtifact["kind"],
        segments: cleaned.segments,
        stats: {
          chars: cleaned.text.length,
          segments: cleaned.segments.length,
        },
        cleaning: cleaned.report,
        createdAt: new Date().toISOString(),
      };

      const key = storageKeys.text(documentId, EXTRACTOR_VERSION);
      await this.storage.putObject(
        key,
        serializeArtifact(artifact),
        "application/json",
      );

      await this.documentRepo.update(documentId, {
        status: "text_ready",
        textKey: key,
        textExtractorVersion: EXTRACTOR_VERSION,
        textChars: artifact.stats.chars,
        textSegments: artifact.stats.segments,
        textReadyAt: new Date(),
        errorMessage: null,
        metadata: jsonb({ ...document.metadata, parserKind: parsed.kind }),
      });

      const r = cleaned.report;
      await this.jobLogger.log(
        job,
        `${parsed.kind}: ${r.charsBefore}→${r.charsAfter} chars, ` +
          `${artifact.stats.segments} segments, rules=[${r.rules.join(",")}]` +
          (r.runningHeader ? `, header stripped` : ""),
      );

      await this.enqueueEvents(documentId);
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

      await this.documentRepo.update(documentId, {
        errorMessage: message,
        textAttempts: () => '"text_attempts" + 1',
      });
      await this.jobLogger.error(job, `failed: ${message}`);
      throw error;
    }
  }

  private async enqueueEvents(documentId: string): Promise<void> {
    await this.eventsQueue.add(
      "extract-events",
      { documentId },
      { jobId: extractEventsJobId(documentId), ...EXTRACT_JOB_OPTIONS },
    );
  }
}
