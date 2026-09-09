// stdio entrypoint — for Claude Desktop via claude_desktop_config.json.
// Writes are enabled here because this transport is local and single-user;
// the public HTTP connector in app/api/mcp/route.ts is read-only.
// See mcp/README.md for setup.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAll } from "./register";

const server = new McpServer({ name: "historical-map", version: "1.0.0" });
registerAll(server, { writable: true });

(async () => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
})();
