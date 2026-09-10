/**
 * Cast for jsonb payloads written through TypeORM.
 *
 * `QueryDeepPartialEntity` maps an entity's object properties *recursively*, so
 * a property typed `Record<string, unknown>` — which is the honest type for a
 * jsonb column — is rejected by `.values()` and `.update()` even though the
 * runtime value is exactly what Postgres wants. Typing the column as `any`
 * instead would fix the writer at the cost of every reader.
 *
 * This is that impedance mismatch and nothing else. It does not skip
 * validation, because there is none to skip: the column accepts any JSON.
 */
export function jsonb(value: Record<string, unknown>): never {
  return value as never;
}
