// Embedding engines and composed texts (plans/12, plans/23). Framework-free:
// the ingest workers wrap these in a Nest module and a sweep
// (services/ingest/libs/embedding); the web app embeds queries with them.
//
// Ships as TypeScript source, like @historical-map/domain.

export * from "./bedrock/bedrock.engine";
export * from "./compose";
export * from "./embedding-engine.interface";
export * from "./engine-from-env";
export * from "./fake/fake.engine";
export * from "./fake/recording.engine";
