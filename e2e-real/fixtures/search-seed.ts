// The search fixture corpus (plans/19-search.md, "Testing strategy").
//
// seed-data.ts was built for pins and popups; ranking needs data designed for
// it, small enough that every expected hit can be asserted by id. Each fixture
// exists to test one thing — the comment on it says what.
//
// All of it lives under its own source and away from MapView's default view
// centre, so the map specs' hover target (fx-loc-1, dead centre) is unaffected.
// Note fx-loc-slc is named "Salt Lake City" but deliberately NOT placed there:
// the default centre *is* Salt Lake City, and a second pin under the hover
// target would make pins-and-popup.spec.ts ambiguous.
import type {
  EventGroup,
  EventSource,
  HistoricalLocation,
} from "../../app/map/types";

export const SEARCH_SOURCE: EventSource = {
  id: "fx-source-search",
  name: "Fixture Search Corpus",
  description: "Ranking fixtures for the search specs.",
  color: "#16a34a",
};

const src = SEARCH_SOURCE.id;

export const SEARCH_LOCATIONS: HistoricalLocation[] = [
  {
    id: "fx-loc-meadows",
    name: "Mountain Meadows",
    coordinates: [-113.62, 37.48],
    events: [
      {
        // Stemming ("massacred", "massacres"), title-over-body ranking, and a
        // word ("Fancher") found only in its source quote.
        id: "fx-ev-massacre",
        title: "Massacre at the Meadows",
        description:
          "A party of emigrants bound for California was killed in southern Utah Territory.",
        source: "the Fancher train was set upon while camped in the valley",
        date: "1857-09-11",
        datePrecision: "day",
        sourceId: src,
      },
      {
        // A sequence member whose title word ("siege") the sequence itself
        // never uses — "match through a member title".
        id: "fx-ev-siege",
        title: "Siege of the Corralled Wagons",
        description:
          "The emigrants circled their wagons and held out for five days.",
        date: "1857-09-07",
        datePrecision: "day",
        sourceId: src,
      },
      {
        id: "fx-ev-burial",
        title: "Burial of the Remains",
        description:
          "An army detachment buried the remains and raised a cairn.",
        date: "1859-05-01",
        datePrecision: "month",
        sourceId: src,
      },
    ],
  },
  {
    id: "fx-loc-cedar",
    name: "Cedar City",
    coordinates: [-113.06, 37.68],
    events: [
      {
        // "meadows" in the body only — ranks below the title match.
        // Also the exact phrase "emigrant camp".
        id: "fx-ev-meadows-body",
        title: "Emigrant Camp Established",
        description:
          "The party rested its cattle on the meadows before the final push west.",
        date: "1857-01-01",
        datePrecision: "year",
        sourceId: src,
      },
      {
        // Has "emigrant" and "camp", but not as the phrase.
        id: "fx-ev-camp-split",
        title: "Camp Floyd Garrisoned",
        description: "Soldiers watched the emigrant road from the new post.",
        date: "1858-07-01",
        datePrecision: "day",
        sourceId: src,
      },
    ],
  },
  {
    id: "fx-loc-harrison",
    name: "Harrison",
    coordinates: [-93.11, 36.23],
    events: [
      {
        // "Fancher" in the description — must outrank the quote-only match.
        id: "fx-ev-departure",
        title: "Departure from Arkansas",
        description: "The Fancher party left Arkansas bound for California.",
        date: "1857-04-01",
        datePrecision: "season",
        dateText: "Spring 1857",
        sourceId: src,
      },
    ],
  },
  {
    id: "fx-loc-mexico",
    name: "Mexico City",
    coordinates: [-99.13, 19.43],
    events: [
      {
        // Accent folding both ways, trigram typo, exact-title top hit.
        id: "fx-ev-tenochtitlan",
        title: "Fall of Tenochtitlán",
        description: "Spanish and allied forces captured the Aztec capital.",
        date: "1521-01-01",
        datePrecision: "year",
        sourceId: src,
      },
      {
        // Inside a 1500–1600 timeline; the "1840s outside the timeline" conflict.
        id: "fx-ev-1520",
        title: "Smallpox Reaches the Valley",
        description:
          "An epidemic devastated the population of the Aztec capital.",
        date: "1520-01-01",
        datePrecision: "year",
        sourceId: src,
      },
    ],
  },
  {
    id: "fx-loc-bridger",
    name: "Fort Bridger",
    coordinates: [-110.38, 41.32],
    events: [
      {
        // Decade parsing: 1843 is in the 1840s.
        id: "fx-ev-1840s-a",
        title: "Trading Post Founded",
        description: "A supply post opened on the emigrant trail.",
        date: "1843-01-01",
        datePrecision: "year",
        sourceId: src,
      },
    ],
  },
  {
    id: "fx-loc-coloma",
    name: "Coloma",
    coordinates: [-120.89, 38.8],
    events: [
      {
        // Precision-aware overlap: circa 1848 spans 1843–1853, so it is in
        // the 1840s *and* overlaps an 1850–1860 range, but not 1855–1860.
        id: "fx-ev-1840s-b",
        title: "Gold Found in the Millrace",
        description:
          "A carpenter noticed flakes of gold in the tailrace of a sawmill.",
        date: "1848-01-01",
        datePrecision: "circa",
        sourceId: src,
      },
    ],
  },
  {
    id: "fx-loc-slc",
    name: "Salt Lake City",
    // Not the real coordinates — see the module comment.
    coordinates: [-112.6, 41.45],
    events: [
      {
        id: "fx-ev-slc-1847",
        title: "Pioneers Enter the Valley",
        description: "The first wagon company descended Emigration Canyon.",
        date: "1847-07-24",
        datePrecision: "day",
        sourceId: src,
      },
      {
        id: "fx-ev-slc-1850",
        title: "University of Deseret Chartered",
        description: "The territorial legislature chartered a university.",
        date: "1850-02-28",
        datePrecision: "day",
        sourceId: src,
      },
      {
        id: "fx-ev-slc-1869",
        title: "Railroad Spur Completed",
        description:
          "A spur line connected the city to the transcontinental railroad.",
        date: "1870-01-10",
        datePrecision: "day",
        sourceId: src,
      },
      {
        id: "fx-ev-slc-1896",
        title: "Statehood Celebrated",
        description: "Crowds gathered as Utah became the forty-fifth state.",
        date: "1896-01-04",
        datePrecision: "day",
        sourceId: src,
      },
    ],
  },
];

/** A sequence of three 1857–1859 members, none of whose titles it repeats. */
export const SEARCH_GROUP: Pick<EventGroup, "id" | "title" | "description"> & {
  memberEventIds: string[];
} = {
  id: "fx-grp-meadows",
  title: "The Mountain Meadows Affair",
  description: "Events in southern Utah, September 1857 and after.",
  memberEventIds: ["fx-ev-siege", "fx-ev-massacre", "fx-ev-burial"],
};

// ── Source documents ────────────────────────────────────────────────────────
//
// Two ingested documents with passages, written through the real ingest
// writer (replacePassages → splitPassages + relinkPassageEvents), so the
// fixtures exercise the same code extract-text and publish run.
//
// `ingest_documents.id` is a uuid, so the plan's "fx-doc-1" is a fixed uuid.
// Every paragraph is over the splitter's 200-char minimum, so each stays its
// own passage; each carries one marker word no other paragraph uses, plus
// "chronicle", which all eight share (the passage-cap case).

export const FX_DOC_1 = "00000000-0000-4000-8000-0000000fd001";
export const FX_DOC_2 = "00000000-0000-4000-8000-0000000fd002";
export const FX_INGEST_SOURCE_ID = "00000000-0000-4000-8000-0000000f5001";

/** The quote of fx-ev-doc-q1 — inside p.1¶2. */
export const DOC_QUOTE_1 =
  "The garrison surrendered the obsidian fortress at dawn after a long investment.";
/** The quote of fx-ev-doc-q2 — inside p.3¶1. */
export const DOC_QUOTE_2 =
  "Traders carried turquoise north along the old road every spring.";

const P1 =
  "This chronicle opens with the ochre hills that ring the basin, where the first settlers built low houses of adobe and stone and counted their seasons by the rains that came and went across the wide, dry plain below.";
const P2 = `The ramparts were tall and the chronicle is plain about what followed. ${DOC_QUOTE_1} Nobody inside had eaten for many days, and the commander saw no reason to prolong the suffering of his people.`;
const P3 =
  "A zephyr from the south carried the smell of rain for weeks before any fell, and the chronicle records that the elders gathered each evening in the plaza to argue over when to plant the maize and the beans.";
// p.1¶4 runs across the page break: page 1 ends mid-sentence.
const P4_PAGE1 =
  "Among the crafts the chronicle praises most highly, none is described at greater length than the work of the weavers of the valley, who practised";
const P4_PAGE2 =
  "quillwork of remarkable delicacy, dyeing porcupine quills with roots and berries and stitching them into patterns that no two families shared.";
const P5 =
  "The marigold fields below the town were the pride of every household, and the chronicle lists, year by year, how many baskets of flowers were carried to the shrine on the hill for the autumn festival.";
const P6 = `Commerce mattered as much as war, and the chronicle gives it equal space. ${DOC_QUOTE_2} They returned with shells, feathers and salt, and the market at the crossing grew larger each year.`;
// Linked to no event — the lenient undated-passage rule's subject.
const P7 =
  "The basalt quarry east of the river supplied every grinding stone in the region, and the chronicle notes that its masons kept their methods secret, passing them only from father to son across generations.";
// Untrusted text: ts_headline must never hand this back as markup.
const P8 =
  "A lantern hung at the gate of the mission every night. <script>alert(1)</script> The chronicle ends here, with the lantern still burning and the gate still open to any traveller who came along the road.";

export const SEARCH_DOCUMENTS = [
  {
    id: FX_DOC_1,
    externalId: "fx-doc-1.pdf",
    title: "Annals of the Obsidian Basin",
    segments: [
      { anchor: "p.1", text: [P1, P2, P3, P4_PAGE1].join("\n") },
      { anchor: "p.2", text: [P4_PAGE2, P5].join("\n") },
      { anchor: "p.3", text: [P6, P7, P8].join("\n") },
    ],
  },
  {
    // No published events — the document panel's empty-events state.
    id: FX_DOC_2,
    externalId: "fx-doc-2.pdf",
    title: "Ledger of the Northern Missions",
    segments: [
      {
        anchor: "p.1",
        text: "The candlewax accounts of the northern missions fill most of this ledger, item after item, with the chronicle of what each mission bought, what it sold, and what it begged from its neighbours in a hard winter.",
      },
    ],
  },
];

export const SEARCH_DOCUMENT_LOCATION = {
  id: "fx-loc-archive",
  name: "Obsidian Basin",
  coordinates: [-106.6, 35.1] as [number, number],
};

/** Events published from FX_DOC_1: two quoted verbatim, one not at all. */
export const SEARCH_DOCUMENT_EVENTS = [
  {
    id: "fx-ev-doc-q1",
    title: "Fortress Surrenders",
    description: "A besieged garrison gave up its stronghold.",
    date: "1650-01-01",
    datePrecision: "year",
    source: DOC_QUOTE_1,
    anchor: "p.1",
  },
  {
    id: "fx-ev-doc-q2",
    title: "Northern Trade Route Opens",
    description: "Merchants began regular journeys north.",
    date: "1700-01-01",
    datePrecision: "year",
    source: DOC_QUOTE_2,
    anchor: "p.3",
  },
  {
    // Its quote appears in no paragraph: no passage link, page anchor only.
    id: "fx-ev-doc-unlinked",
    title: "Embassy Arrives",
    description: "Envoys arrived bearing gifts.",
    date: "1680-01-01",
    datePrecision: "year",
    source:
      "An embassy arrived with gifts that no page of this book records anywhere.",
    anchor: "p.2",
  },
];
