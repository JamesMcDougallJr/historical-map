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
 * One narrative sequence the model proposed across a document's already-
 * extracted events — e.g. "The Outbound Journey" spanning several chunks.
 *
 * This is a raw proposal, not a published grouping: `memberEventIds` are
 * extraction-time `ExtractedEvent.id` values (`"{chunkIndex}-{i}"`, scoped to
 * one `modelRun`), which only mean something to the document they came from.
 * `publish` resolves them to final published event ids and writes the actual
 * `event_groups`/`event_group_members` rows the map reads — those tables
 * belong to the web app's `ensureSchema()` (see `map-writer.service.ts`), so
 * this table exists to hold the proposal in ingest's own schema until publish
 * is ready to translate it.
 *
 * Like `ingest_extractions`, rows are append-only per (document, model_run):
 * a re-extraction proposes sequences fresh under a new `model_run` rather than
 * overwriting the old proposal, so a bad run stays auditable.
 */
@Entity("ingest_event_sequences")
@Index(["documentId"])
export class IngestEventSequence {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "document_id", type: "uuid" })
  documentId!: string;

  @ManyToOne(() => IngestDocument, { onDelete: "CASCADE" })
  @JoinColumn({ name: "document_id" })
  document!: IngestDocument;

  @Column({ name: "model_run", type: "uuid" })
  modelRun!: string;

  @Column({ type: "text" })
  title!: string;

  @Column({ type: "text", nullable: true })
  description!: string | null;

  /** Extraction-time event ids, in narrative order. */
  @Column({ name: "member_event_ids", type: "jsonb" })
  memberEventIds!: string[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
