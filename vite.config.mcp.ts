import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// Rooted at mcp/ so the bundle lands at mcp/dist/mcp-app.html rather than
// nesting a second mcp/ segment under outDir. The tsx entry imports from
// ../app/**, which Vite resolves outside the root fine for builds.
export default defineConfig({
  root: path.resolve(__dirname, "mcp"),
  plugins: [react(), viteSingleFile()],
  build: {
    // Sits next to the server source so Next.js can trace it into the
    // serverless bundle (see outputFileTracingIncludes in next.config.mjs).
    outDir: path.resolve(__dirname, "mcp/dist"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "mcp/mcp-app.html"),
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
});
