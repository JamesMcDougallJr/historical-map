import type { ExtractedEvent } from "@historical-map/domain";
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

export type ReviewReason =
  | "low_confidence"
  | "no_date"
  | "geocode_failed"
  | "possible_duplicate";

/**
 * An extracted event that did not reach the map, and why.
 *
 * The confidence gate is only meaningful if rejected events land somewhere a
 * human can look — otherwise it is a silent delete, and the failure mode is a
 * corpus that quietly ingests half of itself. These rows are what the existing
 * review UI (`EventReviewList`/`EventEditModal`) reads.
 *
 * Deliberately not a flag on the map's `events` table: an event that failed to
 * geocode has no coordinates, and `locations` requires them.
 */
@Entity("ingest_review_items")
@Index(["documentId"])
@Index(["reason"])
export class IngestReviewItem {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ name: "document_id", type: "uuid" })
  documentId!: string;

  @ManyToOne(() => IngestDocument, { onDelete: "CASCADE" })
  @JoinColumn({ name: "document_id" })
  document!: IngestDocument;

  /**
   * The deterministic id this event *would* have had. Makes the row idempotent
   * — re-running publish updates rather than piling up duplicates — and lets an
   * approved item be inserted under the same id the pipeline would have used.
   */
  @Column({ name: "event_key", type: "text", unique: true })
  eventKey!: string;

  @Column({ type: "text" })
  reason!: ReviewReason;

  @Column({ type: "text", nullable: true })
  detail!: string | null;

  @Column({ type: "jsonb" })
  event!: ExtractedEvent;

  @Column({ name: "resolved_at", type: "timestamptz", nullable: true })
  resolvedAt!: Date | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
