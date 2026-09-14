/**
 * Exercises `FallbackGeocoder` and `WhgGeocoder` against a mocked `fetch`.
 * No network, no database, no Redis.
 *
 * `FallbackGeocoder` is fully implemented and should be green already.
 * `WhgGeocoder`'s HTTP methods are stubbed (`geocode.reconcile`,
 * `.fetchEntityCoordinates`) — this file is the acceptance spec to implement
 * them against. Run it, watch it fail, implement, rerun until green:
 *
 *   npm run geocoding:verify --workspace=services/ingest
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
  ) {}

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

const RECONCILE_HIT_BODY = {
  q1: {
    result: [
      {
        id: "place:169687",
        name: "Coloma",
        score: 87.5,
        match: true,
        description: "Country: US",
      },
    ],
  },
};

const RECONCILE_LOW_SCORE_BODY = {
  q1: {
    result: [
      { id: "place:1", name: "Coloma Estates", score: 12, match: false },
    ],
  },
};

const RECONCILE_EMPTY_BODY = { q1: { result: [] } };

const ENTITY_WITH_GEOMETRY_BODY = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [-120.8895, 38.8016] },
  names: [{ toponym: "Coloma" }],
};

const ENTITY_WITHOUT_GEOMETRY_BODY = {
  type: "Feature",
  geometry: null,
  names: [{ toponym: "Coloma" }],
};

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
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_HIT_BODY },
      { status: 200, body: ENTITY_WITH_GEOMETRY_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const hit = await safeGeocode(
      geocoder,
      "Sutter's Mill",
      "a well-scored match resolves without throwing",
    );
    if (hit !== undefined) {
      check(
        "resolves lon/lat from the entity API's geometry.coordinates ([lon, lat])",
        hit?.lon === -120.8895 && hit?.lat === 38.8016,
        JSON.stringify(hit),
      );
      check(
        "displayName comes from the winning candidate's name",
        hit?.displayName === "Coloma",
        hit?.displayName,
      );
    }
    check(
      "reconcile is called, then the entity API for the winning id",
      mock.calls.length === 2 &&
        mock.calls[0]!.url.includes("/reconcile") &&
        mock.calls[1]!.url.includes("place:169687"),
      mock.calls.map((c) => c.url).join(" | "),
    );
    check(
      "reconcile request carries the token and a User-Agent header",
      (() => {
        const init = mock.calls[0]?.init;
        const headers = new Headers(init?.headers);
        const auth = headers.get("authorization") ?? "";
        return (
          init?.method === "POST" &&
          auth.includes("test-token") &&
          !!headers.get("user-agent")
        );
      })(),
    );
    check(
      "reconcile request body queries the given place name",
      (() => {
        const body = mock.calls[0]?.init?.body;
        if (typeof body !== "string") return false;
        const parsed = JSON.parse(body) as {
          queries: Record<string, { query: string }>;
        };
        return Object.values(parsed.queries).some(
          (q) => q.query === "Sutter's Mill",
        );
      })(),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, body: RECONCILE_LOW_SCORE_BODY }]);
    const geocoder = new WhgGeocoder(
      fakeConfig({
        WHG_API_TOKEN: "test-token",
        WHG_MIN_SCORE: 40,
        WHG_MIN_INTERVAL_MS: 0,
      }),
    );
    const hit = await safeGeocode(
      geocoder,
      "Coloma Estates",
      "a candidate below WHG_MIN_SCORE resolves without throwing",
    );
    check(
      "a candidate below WHG_MIN_SCORE is treated as no match",
      hit === null,
      JSON.stringify(hit),
    );
    check(
      "a below-threshold candidate never triggers an entity lookup",
      mock.calls.length === 1,
      `${mock.calls.length} calls`,
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
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_HIT_BODY },
      { status: 200, body: ENTITY_WITHOUT_GEOMETRY_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const hit = await safeGeocode(
      geocoder,
      "Coloma",
      "a geometry-less entity resolves without throwing",
    );
    check(
      "a matched entity with no geometry yields null rather than fabricated coordinates",
      hit === null,
      JSON.stringify(hit),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 500, body: {} }]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const result = await expectRejects(() => geocoder.geocode("Coloma"));
    check(
      "a reconcile HTTP failure throws (retryable), not a cached miss",
      result.threw,
      result.message,
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_HIT_BODY },
      { status: 500, body: {} },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
    );
    const result = await expectRejects(() => geocoder.geocode("Coloma"));
    check(
      "an entity-API HTTP failure throws (retryable), not a cached miss",
      result.threw,
      result.message,
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_HIT_BODY },
      { status: 200, body: ENTITY_WITH_GEOMETRY_BODY },
      { status: 200, body: RECONCILE_HIT_BODY },
      { status: 200, body: ENTITY_WITH_GEOMETRY_BODY },
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

  let failed = 0;
  for (const [name, ok, detail] of checks) {
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  (${detail})` : ""}`,
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
