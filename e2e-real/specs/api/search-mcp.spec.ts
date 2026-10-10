import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { SearchResponse } from "../../../app/map/types";

// The MCP `search` tool over the public, read-only HTTP connector
// (plans/24-search-mcp.md). One core, two callers: it must agree with
// GET /api/search for the same query.

const HEADERS = { "x-api-key": "test-api-key" };

async function connect(): Promise<Client> {
  const client = new Client({ name: "e2e-real-search", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://localhost:3000/api/mcp")),
  );
  return client;
}

async function callSearch(client: Client, args: Record<string, unknown>) {
  const result = await client.callTool({ name: "search", arguments: args });
  const text =
    (result.content as Array<{ type: string; text?: string }>)[0]?.text ?? "";
  return {
    result,
    body: text.startsWith("{") ? (JSON.parse(text) as SearchResponse) : null,
    text,
  };
}

test.describe("MCP search tool (real backend)", () => {
  test("tools/list has search beside search_events, and no write tools", async () => {
    const client = await connect();
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).toContain("search");
    expect(names).toContain("search_events");
    expect(names).not.toContain("add_event");
    expect(names).not.toContain("delete_location");
    await client.close();
  });

  test("returns typed hits plus modes and parsed — the same as /api/search", async ({
    request,
  }) => {
    const client = await connect();
    const { body } = await callSearch(client, { q: "massacred" });
    expect(body).not.toBeNull();
    const hit = body!.hits.find((h) => h.id === "fx-ev-massacre");
    expect(hit?.kind).toBe("event");
    expect(body!.modes).toBeDefined();
    expect(body!.parsed.text).toBe("massacred");

    const api = (await (
      await request.get("/api/search?q=massacred&mode=lexical", {
        headers: HEADERS,
      })
    ).json()) as SearchResponse;
    expect(body!.hits.map((h) => `${h.kind}:${h.id}`)).toEqual(
      api.hits.map((h) => `${h.kind}:${h.id}`),
    );
    await client.close();
  });

  test("kinds restricts the result kinds", async () => {
    const client = await connect();
    const { body } = await callSearch(client, {
      q: "meadows",
      kinds: ["sequence"],
    });
    expect(body!.hits.length).toBeGreaterThan(0);
    expect(new Set(body!.hits.map((h) => h.kind))).toEqual(
      new Set(["sequence"]),
    );
    await client.close();
  });

  test("a query over 200 characters is a schema error, not a crash", async () => {
    const client = await connect();
    const outcome = await client
      .callTool({ name: "search", arguments: { q: "x".repeat(201) } })
      .then((r) => (r.isError ? "error-result" : "ok"))
      .catch(() => "rejected");
    expect(outcome).not.toBe("ok");
    // The server is still fine afterwards.
    const { body } = await callSearch(client, { q: "meadows" });
    expect(body!.hits.length).toBeGreaterThan(0);
    await client.close();
  });

  test("semantic: true says whether meaning-search ran", async () => {
    // S3 (semantic search) isn't built yet: the flag must degrade to lexical
    // results with modes.semantic = false, never fail.
    const client = await connect();
    const { body } = await callSearch(client, { q: "meadows", semantic: true });
    expect(body!.modes.semantic).toBe(false);
    expect(body!.hits.length).toBeGreaterThan(0);
    await client.close();
  });

  test("show_map focus resolves a search hit for the inline map", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "show_map",
      arguments: { focus: { kind: "event", id: "fx-ev-massacre" } },
    });
    const structured = result.structuredContent as {
      focus: { kind: string; eventId?: string; locationId?: string } | null;
      locations: Array<{ id: string }>;
    };
    expect(structured.focus).toMatchObject({
      kind: "event",
      eventId: "fx-ev-massacre",
      locationId: "fx-loc-meadows",
    });
    expect(structured.locations.map((l) => l.id)).toContain("fx-loc-meadows");

    const missing = await client.callTool({
      name: "show_map",
      arguments: { focus: { kind: "event", id: "no-such-event" } },
    });
    expect((missing.content as Array<{ text?: string }>)[0]?.text).toContain(
      "Could not find event no-such-event",
    );
    await client.close();
  });
});
