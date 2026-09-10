import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from "typeorm";
import { IngestDocument } from "./ingest-document.entity";

/**
 * A publisher the `detect` worker polls.
 *
 * `key` is the join between a database row and a `SourceAdapter` in code — it
 * is matched by string, so renaming one without the other silently disables the
 * source (the detect worker logs and skips rather than throwing; code/DB drift
 * during a deploy is expected, not exceptional).
 */
@Entity("ingest_sources")
export class IngestSource {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "text", unique: true })
  key!: string;

  @Column({ name: "display_name", type: "text" })
  displayName!: string;

  @Column({ name: "homepage_url", type: "text", nullable: true })
  homepageUrl!: string | null;

  @Column({ type: "text", nullable: true })
  attribution!: string | null;

  /** Gates polling. A disabled source keeps its documents but stops ticking. */
  @Column({ type: "boolean", default: true })
  enabled!: boolean;

  /**
   * Per-source cadence, as a cron pattern. Null means "use the default".
   * Deliberately per-source rather than a global constant: an archive that
   * publishes quarterly should not be polled 90 times between updates, and
   * several of these are volunteer-run.
   */
  @Column({ name: "poll_cron", type: "text", nullable: true })
  pollCron!: string | null;

  /** Overrides DETECTION_LOOKBACK_DAYS for this source only. */
  @Column({ name: "lookback_days", type: "integer", nullable: true })
  lookbackDays!: number | null;

  /** Adapter-specific settings (endpoint, query, credentials reference). */
  @Column({ type: "jsonb", default: () => "'{}'::jsonb" })
  metadata!: Record<string, unknown>;

  @OneToMany(() => IngestDocument, (document) => document.source)
  documents!: IngestDocument[];

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ name: "updated_at", type: "timestamptz" })
  updatedAt!: Date;
}
