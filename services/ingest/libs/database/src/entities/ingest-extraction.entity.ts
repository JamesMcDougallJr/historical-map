import type { ExtractionResult } from "@historical-map/domain";
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { IngestDocument } from "./ingest-document.entity";

/**
 * One chunk of one extraction pass over one document.
 *
 * **This table is the chunk-level checkpoint.** A long document is extracted in
 * chunks; each successful chunk is persisted here immediately, and a retried
 * job skips indices already present. Without that, exhausting the in-job retry
 * budget on chunk 15 of 18 re-sends all 18 to the model on the next attempt —
 * the documented gap in the pipeline this is modelled on, which cost only
 * free-tier quota there and costs real money here.
 *
 * Rows are append-only per (document, chunk). Re-extracting a document under a
 * better model inserts a new `model_run` rather than updating in place, so a
 * bad model run stays auditable and revertible.
 */
@Entity("ingest_extractions")
@Index(["documentId", "modelRun", "chunkIndex"], { unique: true })
export class IngestExtraction {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "document_id", type: "uuid" })
  documentId!: string;

  @ManyToOne(() => IngestDocument, (document) => document.extractions, {
    onDelete: "CASCADE",
  })
  @JoinColumn({ name: "document_id" })
  document!: IngestDocument;

  /**
   * Groups the chunks of a single pass. Re-extraction starts a new run, so
   * chunk 3 of the old run and chunk 3 of the new one can coexist.
   */
  @Column({ name: "model_run", type: "uuid" })
  modelRun!: string;

  @Column({ type: "text" })
  model!: string;

  @Column({ name: "chunk_index", type: "integer", default: 0 })
  chunkIndex!: number;

  @Column({ name: "chunk_count", type: "integer", default: 1 })
  chunkCount!: number;

  /** `ExtractionResult["events"]` — ParsedEvents plus the raw place name. */
  @Column({ type: "jsonb" })
  events!: ExtractionResult["events"];

  @Column({ name: "event_count", type: "integer" })
  eventCount!: number;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
