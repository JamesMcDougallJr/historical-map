import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from "typeorm";

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

  @CreateDateColumn({ name: "created_at", type: "timestamptz" })
  createdAt!: Date;
}
