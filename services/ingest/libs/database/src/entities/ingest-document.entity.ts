import type { DocumentStatus } from "@historical-map/domain";
import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { IngestExtraction } from "./ingest-extraction.entity";
import { IngestSource } from "./ingest-source.entity";

/**
 * One document on its way to becoming events. Carries the whole pipeline state
 * machine.
 *
 * **The unique index on (source_id, external_id) is the idempotency
 * mechanism.** Detection inserts with ON CONFLICT DO NOTHING and relies on the
 * database to reject duplicates — no control flow in the detect worker enforces
 * it, and none should. Removing this index does not cause a test failure; it
 * causes silent duplicate ingestion.
 */
@Entity("ingest_documents")
@Index(["sourceId", "externalId"], { unique: true })
@Index(["status"])
@Check(`"fetch_attempts" >= 0`)
@Check(`"extract_attempts" >= 0`)
@Check(`"publish_attempts" >= 0`)
export class IngestDocument {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "source_id", type: "uuid" })
  sourceId!: string;

  @ManyToOne(() => IngestSource, (source) => source.documents, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "source_id" })
  source!: IngestSource;

  /** The source's own stable identifier. Half of the dedupe key. */
  @Column({ name: "external_id", type: "text" })
  externalId!: string;

  @Column({ type: "text" })
  url!: string;

  @Column({ type: "text", nullable: true })
  title!: string | null;

  /**
   * When the *source* published this document — not a pipeline timestamp.
   * Bounds the detection lookback window. An 1847 event can be catalogued last
   * Tuesday, so this is about crawl volume, not historical scope.
   */
  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;

  /** Sent back as If-None-Match so an unchanged document costs one 304. */
  @Column({ type: "text", nullable: true })
  etag!: string | null;

  @Column({ name: "content_type", type: "text", nullable: true })
  contentType!: string | null;

  /**
   * Text column with a CHECK rather than a Postgres enum: widening a CHECK is
   * one ordinary migration, whereas ALTER TYPE ... ADD VALUE has transaction
   * restrictions that make it awkward inside one.
   */
  @Column({ type: "text", default: "discovered" })
  status!: DocumentStatus;

  /**
   * What `fetch` extracted. Lives here rather than in object storage — this is
   * tens of KB of text, and a Postgres column removes MinIO, the S3 config, and
   * the whole "which host has the file" class of failure.
   */
  @Column({ name: "extracted_text", type: "text", nullable: true })
  extractedText!: string | null;

  @Column({ name: "fetch_attempts", type: "integer", default: 0 })
  fetchAttempts!: number;

  @Column({ name: "extract_attempts", type: "integer", default: 0 })
  extractAttempts!: number;

  @Column({ name: "publish_attempts", type: "integer", default: 0 })
  publishAttempts!: number;

  @Column({ name: "fetched_at", type: "timestamptz", nullable: true })
  fetchedAt!: Date | null;

  @Column({ name: "extracted_at", type: "timestamptz", nullable: true })
  extractedAt!: Date | null;

  /** Pipeline finished. Named to avoid colliding with `published_at` above. */
  @Column({ name: "completed_at", type: "timestamptz", nullable: true })
  completedAt!: Date | null;

  @Column({ name: "error_message", type: "text", nullable: true })
  errorMessage!: string | null;

  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @OneToMany(() => IngestExtraction, (extraction) => extraction.document)
  extractions!: IngestExtraction[];

  @CreateDateColumn({ name: "detected_at", type: "timestamptz" })
  detectedAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
