// Server-side only: the admin app's route handlers call the ingestion API with
// HTTP Basic credentials, so they never reach the browser. The write endpoints
// (resolving duplicates) fail closed with 503 on the API side until
// BULL_BOARD_PASSWORD is set there.

const BASE = process.env["INGEST_API_URL"] ?? "http://localhost:3100";

export function ingestFetch(path: string, init?: RequestInit): Promise<Response> {
  const user = process.env["BULL_BOARD_USER"] ?? "admin";
  const password = process.env["BULL_BOARD_PASSWORD"] ?? "";
  const auth = Buffer.from(`${user}:${password}`).toString("base64");
  return fetch(`${BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: { ...init?.headers, Authorization: `Basic ${auth}` },
  });
}
