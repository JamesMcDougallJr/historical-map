// What `show_map`'s `focus` resolves to — computed by the server
// (mcp/register.ts) and acted on by the inline App (mcp/mcp-app.tsx) through
// MapView's imperative handle, the same actions /map's search bar uses.
//
// Types only, so the App bundle never pulls in server code.

export type McpFocusKind =
  | "event"
  | "location"
  | "sequence"
  | "person"
  | "document"
  | "passage";

export type McpFocusTarget =
  | {
      kind: "event";
      locationId: string;
      locationName: string;
      coordinates: [number, number];
      eventId: string;
      sourceId: string | null;
    }
  | {
      kind: "location";
      locationId: string;
      locationName: string;
      coordinates: [number, number];
    }
  | {
      /**
       * Sequences, people, documents and passages all become "draw only these
       * locations": the App has no sequence list or document fetch of its own,
       * since the sandbox can't reach this server's API.
       */
      kind: "sequence" | "person" | "document" | "passage";
      title: string;
      locationIds: string[];
      /** In order — seq for a sequence, date for a person — for the path. */
      coordinates: [number, number][];
      path: boolean;
      /**
       * Documents and passages: their text and page only. Never the original
       * file — its presigned URL is an origin the App's CSP blocks, so Claude
       * puts that link in its reply instead.
       */
      passages?: Array<{ anchor: string; snippet: string; focused?: boolean }>;
    };
