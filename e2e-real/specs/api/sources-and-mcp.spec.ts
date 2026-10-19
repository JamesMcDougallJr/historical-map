import { test, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { FX_LOCATIONS, FX_SOURCES } from "../../fixtures/seed-data";

test.describe("GET /api/sources (real backend)", () => {
  test("returns the fixture sources, no API key required", async ({
    request,
  }) => {
    const res = await request.get("/api/sources");
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { sources: { id: string }[] };
    const ids = body.sources.map((s) => s.id);
    for (const source of FX_SOURCES) expect(ids).toContain(source.id);
  });
});

test.describe("MCP connector (/api/mcp, real backend)", () => {
  async function connect(): Promise<Client> {
    const client = new Client({ name: "e2e-real", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("http://localhost:3000/api/mcp"),
    );
    await client.connect(transport);
    return client;
  }

  test("search_events returns fixture data", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "search_events",
      arguments: { q: FX_LOCATIONS[0]!.events[0]!.title },
    });
    const text = (result.content as Array<{ type: string; text?: string }>)[0]
      ?.text;
    expect(text).toContain(FX_LOCATIONS[0]!.events[0]!.title);
    await client.close();
  });

  test("list_sources, list_locations, list_event_groups, get_event_group all return fixture data", async () => {
    const client = await connect();

    const sources = await client.callTool({ name: "list_sources", arguments: {} });
    expect(
      (sources.content as Array<{ text?: string }>)[0]?.text,
    ).toContain(FX_SOURCES[0]!.id);

    const locations = await client.callTool({
      name: "list_locations",
      arguments: {},
    });
    expect(
      (locations.content as Array<{ text?: string }>)[0]?.text,
    ).toContain(FX_LOCATIONS[0]!.id);

    const groups = await client.callTool({
      name: "list_event_groups",
      arguments: {},
    });
    const groupsText = (groups.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(groupsText).toContain("fx-group-1");

    const group = await client.callTool({
      name: "get_event_group",
      arguments: { id: "fx-group-1" },
    });
    expect((group.content as Array<{ text?: string }>)[0]?.text).toContain(
      "Fixture",
    );

    await client.close();
  });

  test("write tools are not reachable over this transport — read-only boundary", async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name);
    expect(names).not.toContain("add_event");
    expect(names).not.toContain("delete_location");
    await client.close();
  });
});
