/**
 * Exercises `FallbackGeocoder` and `WhgGeocoder` against a mocked `fetch`.
 * No network, no database, no Redis.
 *
 *   npm run geocoding:verify --workspace=services/ingest
 *
 * Once implemented, exercise it against the real WHG API with `--live` —
 * requires a token from https://whgazetteer.org 's Profile page:
 *
 *   WHG_API_TOKEN=... npm run geocoding:verify --workspace=services/ingest -- --live
 */
import { ConfigService } from "@nestjs/config";
import type { GeocodeHit, Geocoder } from "../libs/geocoding/src";
import { FallbackGeocoder, WhgGeocoder } from "../libs/geocoding/src";

const checks: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push([name, ok, detail]);
}

async function expectRejects(
  fn: () => Promise<unknown>,
): Promise<{ threw: boolean; message: string }> {
  try {
    await fn();
    return { threw: false, message: "" };
  } catch (error) {
    return {
      threw: true,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * For calls expected to *resolve* (to a hit or to null). Catches an
 * unexpected throw — e.g. an unimplemented stub — and turns it into a single
 * failing check with the error message, rather than crashing the whole
 * script before the rest of the report can print.
 */
async function safeGeocode(
  geocoder: Geocoder,
  placeName: string,
  label: string,
): Promise<GeocodeHit | null | undefined> {
  try {
    return await geocoder.geocode(placeName);
  } catch (error) {
    check(
      label,
      false,
      `threw instead of resolving: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function fakeConfig(env: Record<string, string | number>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

// ── A tiny in-memory Geocoder for exercising FallbackGeocoder ──────────────
class StubGeocoder implements Geocoder {
  callCount = 0;
  constructor(
    readonly providerName: string,
    private readonly behavior:
      | { type: "hit"; hit: GeocodeHit }
      | { type: "miss" }
      | { type: "throw"; error: Error },
  ) { }

  async geocode(): Promise<GeocodeHit | null> {
    this.callCount++;
    if (this.behavior.type === "hit") return this.behavior.hit;
    if (this.behavior.type === "miss") return null;
    throw this.behavior.error;
  }
}

const HIT_A: GeocodeHit = { lon: 1, lat: 2, displayName: "A" };
const HIT_B: GeocodeHit = { lon: 3, lat: 4, displayName: "B" };

// ── Mocked fetch harness for WhgGeocoder ────────────────────────────────────
type MockResponse = { status: number; body: unknown };

function installFetchMock(responses: MockResponse[]): {
  calls: Array<{ url: string; init?: RequestInit }>;
  restore: () => void;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const original = globalThis.fetch;

  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected fetch call to ${url}`);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      json: async () => next.body,
    } as Response;
  }) as typeof fetch;

  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// Shaped after a real `/reconcile` response for "Sutters Mill" (captured
// 2026-09-14): repr_point is [lon, lat], and — the case that matters — a tie
// at score 100 between a match in California and an unrelated same-named
// place in Virginia, plus a `match: false` candidate scoring as high as
// genuine non-matches, so score alone can't be the accept signal.
const RECONCILE_HIT_BODY = {
  q0: {
    result: [
      {
        id: "place:gn:5285192",
        name: "Sutters Mill",
        score: 100,
        match: true,
        description: "Country: US",
        repr_point: [-120.89188, 38.80296],
      },
      {
        id: "place:osm:n3937043163",
        name: "Sutters Mill",
        score: 100,
        match: true,
        description: "Country: US",
        repr_point: [-77.656355, 37.45198],
      },
      {
        id: "place:wd:Q1973789",
        name: "Sutter's Mill",
        score: 40,
        match: false,
        description: "Country: US",
        repr_point: [-120.892361, 38.803472],
      },
    ],
  },
};

const RECONCILE_NO_MATCH_BODY = {
  q0: {
    result: [
      {
        id: "place:1",
        name: "Coloma Estates",
        score: 40,
        match: false,
        repr_point: [-120.9, 38.8],
      },
    ],
  },
};

const RECONCILE_EMPTY_BODY = { q0: { result: [] } };

async function main(): Promise<void> {
  // ── FallbackGeocoder ──────────────────────────────────────────────────
  {
    const first = new StubGeocoder("first", { type: "hit", hit: HIT_A });
    const second = new StubGeocoder("second", { type: "hit", hit: HIT_B });
    const composite = new FallbackGeocoder([first, second]);
    const hit = await composite.geocode("Anywhere");
    check(
      "first provider's hit wins, second never called",
      hit?.lon === HIT_A.lon && second.callCount === 0,
      JSON.stringify(hit),
    );
    check(
      "hit carries the resolving provider's name",
      hit?.provider === "first",
      hit?.provider,
    );
  }

  {
    const first = new StubGeocoder("first", { type: "miss" });
    const second = new StubGeocoder("second", { type: "hit", hit: HIT_B });
    const composite = new FallbackGeocoder([first, second]);
    const hit = await composite.geocode("Anywhere");
    check(
      "a clean miss falls through to the next provider",
      hit?.lon === HIT_B.lon && hit?.provider === "second",
      JSON.stringify(hit),
    );
  }

  {
    const first = new StubGeocoder("first", { type: "miss" });
    const second = new StubGeocoder("second", { type: "miss" });
    const composite = new FallbackGeocoder([first, second]);
    const hit = await composite.geocode("Anywhere");
    check("both providers missing yields null, not an error", hit === null);
  }

  {
    const first = new StubGeocoder("first", {
      type: "throw",
      error: new Error("first is down"),
    });
    const second = new StubGeocoder("second", { type: "hit", hit: HIT_B });
    const composite = new FallbackGeocoder([first, second]);
    const hit = await composite.geocode("Anywhere");
    check(
      "a provider outage falls through rather than propagating",
      hit?.lon === HIT_B.lon && hit?.provider === "second",
      JSON.stringify(hit),
    );
  }

  {
    const first = new StubGeocoder("first", {
      type: "throw",
      error: new Error("first is down"),
    });
    const second = new StubGeocoder("second", {
      type: "throw",
      error: new Error("second is down too"),
    });
    const composite = new FallbackGeocoder([first, second]);
    const result = await expectRejects(() => composite.geocode("Anywhere"));
    check(
      "only total outage (every provider throws) propagates, as the last error",
      result.threw && result.message === "second is down too",
      result.message,
    );
  }

  {
    let threw = false;
    try {
      new FallbackGeocoder([]);
    } catch {
      threw = true;
    }
    check("constructing with zero providers throws immediately", threw);
  }

  // ── WhgGeocoder ───────────────────────────────────────────────────────
  {
    const geocoder = new WhgGeocoder(fakeConfig({}));
    const result = await expectRejects(() => geocoder.geocode("Coloma"));
    check(
      "missing WHG_API_TOKEN throws a config error naming the variable",
      result.threw && result.message.includes("WHG_API_TOKEN"),
      result.message,
    );
  }

  {
    const mock = installFetchMock([{ status: 200, body: RECONCILE_HIT_BODY }]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const hit = await safeGeocode(
      geocoder,
      "Sutters Mill",
      "a matched candidate resolves without throwing",
    );
    if (hit !== undefined) {
      check(
        "repr_point [lon, lat] maps to hit.lon/hit.lat, not swapped",
        hit?.lon === -120.89188 && hit?.lat === 38.80296,
        JSON.stringify(hit),
      );
      check(
        "tied top-score matches: the first candidate wins (documented limitation)",
        hit?.displayName?.startsWith("Sutters Mill") ?? false,
        hit?.displayName,
      );
    }
    check(
      "exactly one request is made — no second (entity) lookup",
      mock.calls.length === 1 && mock.calls[0]!.url.includes("/reconcile"),
      mock.calls.map((c) => c.url).join(" | "),
    );
    check(
      "request carries Bearer token and a User-Agent header",
      (() => {
        const init = mock.calls[0]?.init;
        const headers = new Headers(init?.headers);
        const auth = headers.get("authorization") ?? "";
        return (
          init?.method === "POST" &&
          auth === "Bearer test-token" &&
          !!headers.get("user-agent")
        );
      })(),
    );
    check(
      "request body queries the given place name under key q0",
      (() => {
        const body = mock.calls[0]?.init?.body;
        if (typeof body !== "string") return false;
        const parsed = JSON.parse(body) as {
          queries: Record<string, { query: string }>;
        };
        return parsed.queries["q0"]?.query === "Sutters Mill";
      })(),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, body: RECONCILE_NO_MATCH_BODY }]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const hit = await safeGeocode(
      geocoder,
      "Coloma Estates",
      "a same-scoring non-match resolves without throwing",
    );
    check(
      "a candidate with match:false is rejected even at a passing score",
      hit === null,
      JSON.stringify(hit),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, body: RECONCILE_EMPTY_BODY }]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const hit = await safeGeocode(
      geocoder,
      "Nowhere At All",
      "zero candidates resolves without throwing",
    );
    check("zero candidates yields null", hit === null, JSON.stringify(hit));
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 401, body: {} }]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "bad-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const result = await expectRejects(() => geocoder.geocode("Coloma"));
    check(
      "an HTTP failure (e.g. bad token) throws (retryable), not a cached miss",
      result.threw,
      result.message,
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_HIT_BODY },
      { status: 200, body: RECONCILE_HIT_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 50 }),
    );
    const start = Date.now();
    await safeGeocode(geocoder, "Coloma", "first rate-limit call resolves without throwing");
    await safeGeocode(geocoder, "Coloma", "second rate-limit call resolves without throwing");
    const elapsed = Date.now() - start;
    check(
      "back-to-back requests are spaced by WHG_MIN_INTERVAL_MS",
      elapsed >= 45,
      `${elapsed}ms`,
    );
    mock.restore();
  }

  // ── Optional live call ────────────────────────────────────────────────────
  // Same idea as extract:verify's `--live`: this is an internal library with
  // no HTTP route of its own to hit from Postman/curl, so the acceptance
  // script itself is the harness for a real network round trip. Unlike the
  // mocked checks above, a live WHG response can't be asserted byte-for-byte
  // (their index changes), so this prints what came back for a human to
  // eyeball rather than pinning exact coordinates.
  if (process.argv.includes("--live")) {
    const token = process.env["WHG_API_TOKEN"];
    if (!token) {
      check("live call", false, "--live given but WHG_API_TOKEN is unset");
    } else {
      const geocoder = new WhgGeocoder({
        get: (key: string) => process.env[key],
      } as unknown as ConfigService);

      for (const place of ["Sutter's Mill", "Promontory Summit", "Nonexistent Place Zzyzx123"]) {
        const result = await expectRejects(async () => {
          const hit = await geocoder.geocode(place);
          console.log(`  "${place}" ->`, hit);
        });
        check(`live geocode("${place}") does not throw`, !result.threw, result.message);
      }
    }
  }

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${detail && (!ok || process.argv.includes("--live")) ? `  (${detail})` : ""}`,
    );
    if (!ok) failed++;
  }
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
