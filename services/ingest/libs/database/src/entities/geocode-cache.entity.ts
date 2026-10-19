import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

export type GeocodeReviewStatus = "auto" | "confirmed" | "rejected";

/**
 * The audit trail of a model-made geocode: enough to judge a rejection
 * against what was actually asked.
 */
export interface GeocodeDecision {
  /** Which step decided: `jev-context` today. */
  method: string;
  /** The gazetteer tiers' own answer, before Jev — null if they declined. */
  tierHit: { lon: number; lat: number; displayName: string } | null;
  /** Jev's pick; null when it answered "none of these". */
  picked: { lon: number; lat: number; displayName: string } | null;
  confidence: number;
  threshold: number;
  /** Whether Jev's pick was applied (it cleared the threshold and differed). */
  applied: boolean;
  /** The event text Jev judged the place against. */
  context: { title: string; description?: string };
  candidates: Array<{ lon: number; lat: number; displayName: string }>;
}

/**
 * Resolved place names, keyed on a normalised form.
 *
 * Across a corpus the same handful of places recur constantly — "Salt Lake
 * Valley" will appear on hundreds of pages — so this turns geocoding from a
 * per-event cost into a per-place one. It also means a geocoder outage degrades
 * to "no new places" rather than "nothing publishes".
 *
 * Misses are cached too (`found = false`). Without that, every run re-asks the
 * geocoder about the same unresolvable place and re-spends the rate limit on a
 * question already answered.
 */
@Entity("geocode_cache")
export class GeocodeCache {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  /** Lowercased, punctuation-stripped, whitespace-collapsed place name. */
  @Column({ name: "normalized_name", type: "text", unique: true })
  normalizedName!: string;

  /** What the document actually said, kept for debugging a bad match. */
  @Column({ name: "raw_name", type: "text" })
  rawName!: string;

  @Column({ type: "double precision", nullable: true })
  lon!: number | null;

  @Column({ type: "double precision", nullable: true })
  lat!: number | null;

  /** False means "asked and got nothing" — distinct from "never asked". */
  @Column({ type: "boolean", default: false })
  found!: boolean;

  /** Which geocoder answered, so a cache built by one is auditable. */
  @Column({ type: "text", nullable: true })
  provider!: string | null;

  /** The provider's own label for what it matched, for spot-checking. */
  @Column({ name: "display_name", type: "text", nullable: true })
  displayName!: string | null;

  /**
   * Other candidates the provider considered equally confident to the chosen
   * hit (tied top score/importance), excluding the hit itself. Stored even
   * though nothing reads it yet — a human review tool needs to know a pick
   * was ambiguous, and that can only be answered if the ties were kept at
   * resolve time; the provider response isn't retained anywhere else.
   */
  @Column({ type: "jsonb", nullable: true })
  candidates!: Array<{ lon: number; lat: number; displayName: string }> | null;

  /**
   * How sure the deciding step was, 0–1. Set by a Jev context decision; null
   * for the deterministic tiers, which either pass their checks or decline.
   */
  @Column({ type: "double precision", nullable: true })
  confidence!: number | null;

  /**
   * `auto` until a person reviews it. `confirmed` pins the answer so no
   * refresh changes it; `rejected` makes it a miss that nothing re-pins.
   */
  @Column({ name: "review_status", type: "text", default: "auto" })
  reviewStatus!: GeocodeReviewStatus;

  @Column({ name: "reviewed_at", type: "timestamptz", nullable: true })
  reviewedAt!: Date | null;

  /** What each tier said and what Jev picked — see `GeocodeDecision`. */
  @Column({ type: "jsonb", nullable: true })
  decision!: GeocodeDecision | null;

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
