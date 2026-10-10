// Drives the stdio MCP server (`npm run mcp`) through the SDK's stdio client,
// with no POSTGRES_URL — the JSON tier the stdio server usually runs on — and
// checks the `search` tool (plans/24-search-mcp.md):
//
//   npm run mcp:verify
//
// Manual, like the ingest verifiers: it spawns a tsx process, which takes a
// few seconds, and needs nothing else.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string) =>
  checks.push([name, ok, detail]);

async function main(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && k !== "POSTGRES_URL") env[k] = v;
  }
  const transport = new StdioClientTransport({
    command: "npx",
    args: ["tsx", "mcp/server.ts"],
    env,
  });
  const client = new Client({ name: "verify-mcp-search", version: "1.0.0" });
  await client.connect(transport);
  try {
    const tools = (await client.listTools()).tools.map((t) => t.name);
    check("tools/list includes search", tools.includes("search"));
    check("search_events is still there", tools.includes("search_events"));

    // "telegraph" is in data/map-data.json's Salt Lake City events.
    const result = await client.callTool({
      name: "search",
      arguments: { q: "telegraph" },
    });
    const text =
      (result.content as Array<{ type: string; text?: string }>)[0]?.text ??
      "{}";
    const body = JSON.parse(text) as {
      hits: Array<{ kind: string; id: string }>;
      modes: { documents: boolean; semantic: boolean };
    };
    const events = body.hits.filter((h) => h.kind === "event");
    check(
      "search returns event hits from the JSON tier",
      events.length > 0,
      JSON.stringify(events.map((e) => e.id)),
    );
    check(
      "modes.documents is false without Postgres",
      body.modes.documents === false,
    );
    check(
      "modes.semantic is false without Postgres",
      body.modes.semantic === false,
    );

    const semantic = await client.callTool({
      name: "search",
      arguments: { q: "telegraph", semantic: true },
    });
    const semanticBody = JSON.parse(
      (semantic.content as Array<{ text?: string }>)[0]?.text ?? "{}",
    ) as { modes: { semantic: boolean }; hits: unknown[] };
    check(
      "semantic: true degrades to lexical, and says so",
      semanticBody.modes.semantic === false && semanticBody.hits.length > 0,
    );

    const tooLong = await client
      .callTool({ name: "search", arguments: { q: "x".repeat(201) } })
      .then((r) => Boolean(r.isError))
      .catch(() => true);
    check("a query over 200 characters is rejected by the schema", tooLong);
  } finally {
    await client.close();
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    if (!ok) failed++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`,
    );
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
