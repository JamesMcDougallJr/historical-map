// Public read-only MCP connector over Streamable HTTP.
//
// Add this URL under Claude → Customize → Connectors → Add custom connector.
// Stateless (no session id) per MCP 2026-07-28, which is what lets it run as a
// serverless function: every request builds its own server + transport.
//
// Read-only on purpose — see registerAll's `writable` flag. Writes stay on the
// stdio transport in mcp/server.ts.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerAll } from "@/mcp/register";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handle(request: Request): Promise<Response> {
  const server = new McpServer({ name: "historical-map", version: "1.0.0" });
  registerAll(server, { writable: false });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  await server.connect(transport);
  const response = await transport.handleRequest(request);

  // Nothing to resume between invocations; a lingering transport would keep the
  // function warm for a stream no one can reconnect to.
  await transport.close().catch(() => {});
  await server.close().catch(() => {});

  return response;
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;

export function OPTIONS(): Response {
  return new Response(null, { status: 204 });
}
