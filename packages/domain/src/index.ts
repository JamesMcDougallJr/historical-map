// The shared vocabulary between the web app (`/map`, the MCP App) and the
// ingestion workers (`services/ingest`). Everything here describes *what a
// historical event is*, never how it is stored, served, or drawn — those stay
// in whichever app owns them.
//
// Ships as TypeScript source, not a build artifact. Next transpiles it via
// `transpilePackages` in next.config.mjs; the Nest workspace picks it up
// through a tsconfig path mapping. Neither has to build this package first.

export * from "./dates";
export * from "./events";
export * from "./ingestion";
