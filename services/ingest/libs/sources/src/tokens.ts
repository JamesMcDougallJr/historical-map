/**
 * DI token for the registered `SourceAdapter[]`.
 *
 * Its own file so a consumer can inject the adapters without importing any
 * concrete adapter — the same reason the extraction engine's token is separate
 * from its engine.
 */
export const SOURCE_ADAPTERS = "SOURCE_ADAPTERS";
