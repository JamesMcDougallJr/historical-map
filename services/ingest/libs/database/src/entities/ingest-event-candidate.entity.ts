import type {
  EventVerdict,
  ExtractedEvent,
  ValidationCheck,
} from "@historical-map/domain";
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
 * An extracted event plus the validator's verdict on it.
 *
 * Replaces the earlier `ingest_review_items`, which recorded only rejects. One
 * table for "an event and what we think of it" is better than two, because the
 * interesting question is usually comparative — how many events passed, and on
 * which check did the rest fail.
 *
 * `checks` keeps every result, not just the failures, including non-gating ones
 * like the grounding check. That is what makes it possible to set a gating
 * policy from evidence later instead of guessing now.
 */
@Entity("ingest_event_candidates")
@Index(["documentId"])
@Index(["verdict"])
export class IngestEventCandidate {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "document_id", type: "uuid" })
  documentId!: string;

  @ManyToOne(() => IngestDocument, { onDelete: "CASCADE" })
  @JoinColumn({ name: "document_id" })
  document!: IngestDocument;

  @Column({ name: "model_run", type: "uuid" })
  modelRun!: string;

  /**
   * The deterministic id this event will have on the map. Unique, so
   * re-validating a document updates in place rather than piling up rows, and
   * an approved review item can be published under the id the pipeline would
   * have used anyway.
   */
  @Column({ name: "event_key", type: "text", unique: true })
  eventKey!: string;

  @Column({ type: "text" })
  verdict!: EventVerdict;

  @Column({ type: "jsonb" })
  checks!: ValidationCheck[];

  @Column({ type: "jsonb" })
  event!: ExtractedEvent;

  /** Set when a human has dealt with a `review` candidate. */
  @Column({ name: "resolved_at", type: "timestamptz", nullable: true })
  resolvedAt!: Date | null;

  /** Set once `publish` has written this to the map. */
  @Column({ name: "published_at", type: "timestamptz", nullable: true })
  publishedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
