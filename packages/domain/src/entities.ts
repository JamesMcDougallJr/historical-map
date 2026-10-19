// Named entities mentioned by events — people today; organisations, ships
// and nations would be further `type`s in the same `event_entities` table
// (plans/22-search-people.md, "Other entities, same pattern").
//
// A mention is verbatim text, not an identity: "Brigham Young" and
// "President Young" are two names until Level 3's resolver says otherwise.
// `normalizeEntityName` only removes what can't change who is meant.

export const ENTITY_TYPES = ["person"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Leading honorifics and titles, stripped when a name remains without them. */
const HONORIFICS = new Set([
  "president",
  "brother",
  "sister",
  "elder",
  "bishop",
  "general",
  "gen",
  "colonel",
  "col",
  "captain",
  "capt",
  "lieutenant",
  "lt",
  "major",
  "maj",
  "governor",
  "gov",
  "mayor",
  "judge",
  "senator",
  "doctor",
  "dr",
  "mr",
  "mrs",
  "miss",
  "ms",
  "rev",
  "reverend",
  "father",
  "fray",
  "padre",
  "don",
  "dona",
  "sir",
]);

/**
 * The key mentions are grouped and matched by: unaccented, lowercased,
 * punctuation collapsed, leading honorifics removed.
 *
 * An honorific is only stripped while at least two words remain, so
 * "President Brigham Young" → "brigham young", but "President Young" stays
 * "president young" — collapsing it to "young" would merge every Young in
 * the corpus, which is exactly the identity guess this level refuses to make.
 */
export function normalizeEntityName(name: string): string {
  const words = name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' -]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 2 && HONORIFICS.has(words[0]!.replace(/\.$/, ""))) {
    words.shift();
  }
  return words.join(" ");
}

/** Distinct, trimmed, non-empty mentions — what gets written for one event. */
export function cleanMentions(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names ?? []) {
    const name = raw.replace(/\s+/g, " ").trim();
    const norm = normalizeEntityName(name);
    if (!name || !norm || seen.has(norm)) continue;
    seen.add(norm);
    out.push(name);
  }
  return out;
}
