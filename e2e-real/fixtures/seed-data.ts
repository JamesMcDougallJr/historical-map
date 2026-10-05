// Small, hand-built fixture dataset for the real-backend E2E suite.
//
// Deliberately not data/map-data.json — that's real demo content, not built
// for assertions. Every id here is a fixed literal that specs assert against
// directly.
import type { EventGroup, EventSource, HistoricalLocation } from "../../app/map/types";
import { PIN_LON, PIN_LAT } from "../../e2e/fixtures";

export const FX_SOURCES: EventSource[] = [
  {
    id: "fx-source-1",
    name: "Fixture Source One",
    description: "First fixture source for the real-backend suite.",
    color: "#e11d48",
  },
  {
    id: "fx-source-2",
    name: "Fixture Source Two",
    description: "Second fixture source for the real-backend suite.",
    color: "#2563eb",
  },
];

/**
 * Location 1 sits exactly at MapView's hardcoded default view center, same
 * trick as e2e/fixtures.ts's TEST_LOCATION — it lands dead center of the
 * viewport regardless of window size.
 */
export const FX_LOCATIONS: HistoricalLocation[] = [
  {
    id: "fx-loc-1",
    name: "Fixture Location One",
    coordinates: [PIN_LON, PIN_LAT],
    events: [
      {
        id: "fx-event-1",
        title: "Fixture Event One",
        description: "First fixture event, early in the range.",
        date: "1840-01-01",
        datePrecision: "year",
        sourceId: "fx-source-1",
      },
      {
        id: "fx-event-2",
        title: "Fixture Event Two",
        description: "Second fixture event, mid-range.",
        date: "1890-06-15",
        sourceId: "fx-source-1",
      },
    ],
  },
  {
    id: "fx-loc-2",
    name: "Fixture Location Two",
    coordinates: [PIN_LON + 2, PIN_LAT + 1],
    events: [
      {
        id: "fx-event-3",
        title: "Fixture Event Three",
        description: "Third fixture event, later in the range.",
        date: "1935-03-01",
        datePrecision: "year",
        sourceId: "fx-source-2",
      },
      {
        id: "fx-event-4",
        title: "Fixture Event Four",
        description: "Fourth fixture event, latest in the range.",
        date: "1960-11-20",
        sourceId: "fx-source-2",
      },
    ],
  },
  {
    id: "fx-loc-3",
    name: "Fixture Location Three",
    coordinates: [PIN_LON - 2, PIN_LAT - 1],
    events: [
      {
        id: "fx-event-5",
        title: "Fixture Event Five",
        description: "Fifth fixture event, spanning both sources' colors.",
        date: "1900-01-01",
        datePrecision: "year",
        sourceId: "fx-source-1",
      },
    ],
  },
];

/** Cross-location sequence: fx-event-1 (loc 1) -> fx-event-3 (loc 2). */
export const FX_GROUP: Pick<
  EventGroup,
  "id" | "title" | "description"
> & { memberEventIds: string[] } = {
  id: "fx-group-1",
  title: "Fixture Sequence One",
  description: "A fixture sequence spanning two locations.",
  memberEventIds: ["fx-event-1", "fx-event-3"],
};
