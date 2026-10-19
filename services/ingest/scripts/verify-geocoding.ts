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
import type { RateLimiterService } from "../libs/common/src";
import type { JevClient } from "../libs/jev/src";
import type {
  GeocodeHints,
  GeocodeHit,
  GeocodeOutcome,
  Geocoder,
} from "../libs/geocoding/src";
import {
  FallbackGeocoder,
  NominatimGeocoder,
  WhgGeocoder,
  decideWithContext,
} from "../libs/geocoding/src";

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

function fakeConfig(env: Record<string, string | number | boolean>): ConfigService {
  return {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
}

/**
 * Stands in for the Redis-backed limiter — no network, no Redis. Always
 * allows, so `respectRateLimit` falls through to its own `minIntervalMs`
 * wait every call, same as before the Redis limiter existed.
 */
function fakeRateLimiter(): RateLimiterService {
  return {
    registerRateLimit: () => {},
    isAllowedForSource: () => async () => false,
  } as unknown as RateLimiterService;
}

/**
 * `enabled: false` by default, so `NominatimGeocoder.rerank` short-circuits
 * before ever calling `tryAsk` — every fixture that exercises the pre-Jev
 * reranking path uses the no-args form, and keeps doing so regardless of
 * what a real `JevClient` would otherwise do. Pass `pick` to
 * simulate an enabled client answering a rerank question instead.
 */
function fakeJevClient(
  options: { enabled?: boolean; pick?: number | "none" | null; confidence?: number } = {},
): JevClient {
  return {
    enabled: options.enabled ?? false,
    ask: async () => {
      throw new Error("fakeJevClient.ask should not be called directly in these fixtures");
    },
    // `pick` is the candidate index Jev "chooses" (or "none"); null simulates a
    // failed call. `confidence` defaults high enough to clear the 0.8 default bar.
    tryAsk: async () =>
      options.pick === null || options.pick === undefined
        ? null
        : {
            best: {
              type: "choice",
              choice: options.pick === "none" ? "none" : `result_${options.pick}`,
              confidence: options.confidence ?? 0.9,
              probabilities: {},
            },
          },
  } as unknown as JevClient;
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

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
// place in Virginia, both from modern gazetteers, plus a `match: false`
// candidate scoring as high as genuine non-matches, so score alone can't be
// the accept signal.
const RECONCILE_TIE_BODY = {
  q0: {
    result: [
      {
        id: "place:gn:5285192",
        name: "Sutters Mill",
        score: 100,
        match: true,
        namespace: "gn",
        description: "Country: US",
        repr_point: [-120.89188, 38.80296],
      },
      {
        id: "place:osm:n3937043163",
        name: "Sutters Mill",
        score: 100,
        match: true,
        namespace: "osm",
        description: "Country: US",
        repr_point: [-77.656355, 37.45198],
      },
      {
        id: "place:wd:Q1973789",
        name: "Sutter's Mill",
        score: 40,
        match: false,
        namespace: "wd",
        description: "Country: US",
        repr_point: [-120.892361, 38.803472],
      },
    ],
  },
};

// "Sutter's Mill" as documents actually spell it (captured 2026-10-14): one
// Wikidata match, so there is nothing to disambiguate.
const RECONCILE_HIT_BODY = {
  q0: {
    result: [
      {
        id: "place:gn:5285192",
        name: "Sutters Mill",
        score: 100,
        match: false,
        namespace: "gn",
        description: "Country: US",
        repr_point: [-120.89188, 38.80296],
      },
      {
        id: "place:wd:Q1973789",
        name: "Sutter's Mill",
        score: 99,
        match: true,
        namespace: "wd",
        description: "Country: US",
        repr_point: [-120.892361, 38.803472],
      },
    ],
  },
};

// "New Mexico" (captured 2026-10-14): GeoNames ranks a hamlet in Québec first,
// but the only historical-source match is the territory itself.
const RECONCILE_HISTORICAL_TIEBREAK_BODY = {
  q0: {
    result: [
      {
        id: "place:gn:6077243",
        name: "New Mexico",
        score: 100,
        match: true,
        namespace: "gn",
        description: "Country: CA",
        repr_point: [-71.45703, 45.35977],
      },
      {
        id: "place:ohm:r2750913",
        name: "New Mexico",
        score: 100,
        match: true,
        namespace: "ohm",
        description: "Country: US, MX",
        repr_point: [-106.045316, 34.167167],
      },
      {
        id: "place:gn:890299",
        name: "New Mexico",
        score: 100,
        match: true,
        namespace: "gn",
        description: "Country: ZW",
        repr_point: [31.18333, -17.93333],
      },
    ],
  },
};

// "Promontory Summit" (captured 2026-10-14): two sources, one place.
const RECONCILE_AGREEING_BODY = {
  q0: {
    result: [
      {
        id: "place:gn:5779349",
        name: "Promontory Summit",
        score: 100,
        match: true,
        namespace: "gn",
        description: "Country: US",
        repr_point: [-112.5483, 41.61854],
      },
      {
        id: "place:wd:Q2112513",
        name: "Promontory Summit",
        score: 99,
        match: true,
        namespace: "wd",
        description: "Country: US",
        repr_point: [-112.548304, 41.618537],
      },
    ],
  },
};

// WHG can return a matched record it could not locate (observed on "Mexico"
// and "Lago de Texcoco"). Destructuring it used to throw.
const RECONCILE_NULL_POINT_BODY = {
  q0: {
    result: [
      {
        id: "place:ohm:r1",
        name: "Lago de Texcoco",
        score: 100,
        match: true,
        namespace: "ohm",
        repr_point: null,
      },
      {
        id: "place:wd:Q1056282",
        name: "Lake Texcoco",
        score: 99,
        match: true,
        namespace: "wd",
        description: "Country: MX",
        repr_point: [-98.99, 19.5],
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
    const geocoder = new WhgGeocoder(fakeConfig({}), fakeRateLimiter());
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
      fakeRateLimiter(),
    );
    const hit = await safeGeocode(
      geocoder,
      "Sutters Mill",
      "a matched candidate resolves without throwing",
    );
    if (hit !== undefined) {
      check(
        "repr_point [lon, lat] maps to hit.lon/hit.lat, not swapped",
        hit?.lon === -120.892361 && hit?.lat === 38.803472,
        JSON.stringify(hit),
      );
      check(
        "a match:false candidate is never picked, even when it scores higher",
        hit?.displayName?.startsWith("Sutter's Mill") ?? false,
        hit?.displayName,
      );
      check(
        "a match:false candidate never appears as an alternate",
        !hit?.alternates?.length,
        JSON.stringify(hit?.alternates),
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
    const mock = installFetchMock([{ status: 200, body: RECONCILE_TIE_BODY }]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
    );
    const hit = await safeGeocode(
      geocoder,
      "Sutters Mill",
      "tied modern homonyms resolve without throwing",
    );
    check(
      "tied matches in different places, none historical: null, so Nominatim decides",
      hit === null,
      JSON.stringify(hit),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_HISTORICAL_TIEBREAK_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
    );
    const hit = await safeGeocode(
      geocoder,
      "New Mexico",
      "a historical tie-break resolves without throwing",
    );
    check(
      "the historical source's answer wins over modern homonyms ranked above it",
      hit?.lon === -106.045316 && hit?.lat === 34.167167,
      JSON.stringify(hit),
    );
    check(
      "the tied modern homonyms are kept as alternates, not silently dropped",
      hit?.alternates?.length === 2 &&
        hit.alternates.some((a) => a.lon === -71.45703) &&
        hit.alternates.some((a) => a.lon === 31.18333),
      JSON.stringify(hit?.alternates),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_AGREEING_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
    );
    const hit = await safeGeocode(
      geocoder,
      "Promontory Summit",
      "agreeing matches resolve without throwing",
    );
    check(
      "matches from several sources at one place: the top one is taken",
      hit?.lon === -112.5483 && hit?.lat === 41.61854,
      JSON.stringify(hit),
    );
    check(
      "a second source agreeing on the same place is not an alternate",
      !hit?.alternates?.length,
      JSON.stringify(hit?.alternates),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_NULL_POINT_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
    );
    const hit = await safeGeocode(
      geocoder,
      "Lake Texcoco",
      "a matched candidate with a null repr_point does not throw",
    );
    check(
      "a matched candidate with no point is skipped; the located one is used",
      hit?.lon === -98.99 && hit?.lat === 19.5,
      JSON.stringify(hit),
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_NO_MATCH_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
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
    const mock = installFetchMock([
      { status: 200, body: RECONCILE_EMPTY_BODY },
    ]);
    const geocoder = new WhgGeocoder(
      fakeConfig({ WHG_API_TOKEN: "test-token", WHG_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
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
      fakeRateLimiter(),
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
      fakeRateLimiter(),
    );
    const start = Date.now();
    await safeGeocode(
      geocoder,
      "Coloma",
      "first rate-limit call resolves without throwing",
    );
    await safeGeocode(
      geocoder,
      "Coloma",
      "second rate-limit call resolves without throwing",
    );
    const elapsed = Date.now() - start;
    check(
      "back-to-back requests are spaced by WHG_MIN_INTERVAL_MS",
      elapsed >= 45,
      `${elapsed}ms`,
    );
    mock.restore();
  }

  // ── NominatimGeocoder alternates ────────────────────────────────────────
  {
    const mock = installFetchMock([
      {
        status: 200,
        body: [
          {
            lon: "-111.8910",
            lat: "40.7608",
            name: "Salt Lake Valley",
            display_name: "Salt Lake Valley, Utah, USA",
            category: "natural",
            importance: 0.55,
          },
          {
            lon: "-111.9",
            lat: "40.75",
            name: "Levoy Drive",
            display_name: "Levoy Drive",
            category: "highway",
            importance: 0.9, // higher, but rejected category — must not win
          },
          {
            lon: "-112.05",
            lat: "40.7",
            name: "Salt Lake Valley",
            display_name: "Salt Lake Valley (alt)",
            category: "natural",
            importance: 0.55, // tied with the chosen result
          },
        ],
      },
    ]);
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
      fakeJevClient(),
    );
    const hit = await safeGeocode(
      geocoder,
      "Salt Lake Valley",
      "a same-importance non-rejected-category result resolves without throwing",
    );
    if (hit !== undefined) {
      check(
        "a rejected category (highway) is skipped even at higher importance",
        hit?.displayName === "Salt Lake Valley, Utah, USA",
        hit?.displayName,
      );
      check(
        "the tied natural-category candidate is stored as an alternate",
        hit?.alternates?.length === 1 && hit.alternates[0]?.lon === -112.05,
        JSON.stringify(hit?.alternates),
      );
    }
    mock.restore();
  }

  {
    const mock = installFetchMock([
      {
        status: 200,
        body: [
          {
            lon: "-111.8910",
            lat: "40.7608",
            name: "Salt Lake Valley",
            display_name: "Salt Lake Valley, Utah, USA",
            category: "natural",
            // No `importance` field at all — some Nominatim responses omit it.
          },
        ],
      },
    ]);
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
      fakeJevClient(),
    );
    const hit = await safeGeocode(
      geocoder,
      "Salt Lake Valley",
      "a result with no importance field resolves without throwing",
    );
    check(
      "missing importance means no alternates, not a guess",
      hit !== undefined && hit?.alternates === undefined,
      JSON.stringify(hit),
    );
    mock.restore();
  }

  // ── NominatimGeocoder confidence gate ───────────────────────────────────
  // Each case is a real response (captured 2026-10-14) from the first
  // production corpus, trimmed to the fields the gate reads.
  const gateCases: Array<{
    name: string;
    place: string;
    body: unknown[];
    hints?: GeocodeHints;
    /** Expected hit longitude, or the start of the decline reason. */
    expect: { lon: number } | { declined: string };
  }> = [
    {
      name: "a result not called that at all is declined (New Spain → Spain Reserve)",
      place: "New Spain",
      body: [
        { lon: "151.0088", lat: "-33.7204", name: "Spain Reserve", display_name: "Spain Reserve, Castle Hill, Sydney", category: "leisure", importance: 0.08 },
      ],
      expect: { declined: "name mismatch" },
    },
    {
      name: "a hamlet that merely shares the name is declined (low importance)",
      place: "Santiago Tlatelolco",
      body: [
        { lon: "-103.2505", lat: "22.1399", name: "Santiago Tlatelolco", display_name: "Santiago Tlatelolco, Colotlán, Jalisco", category: "place", importance: 0.133 },
      ],
      expect: { declined: "low importance" },
    },
    {
      name: "equally prominent same-named places far apart are declined (tie)",
      place: "Vera Cruz",
      body: [
        { lon: "-52.5007", lat: "-29.7157", name: "Vera Cruz", display_name: "Vera Cruz, Rio Grande do Sul", category: "boundary", importance: 0.526 },
        { lon: "-50.0", lat: "-22.2", name: "Vera Cruz", display_name: "Vera Cruz, São Paulo", category: "boundary", importance: 0.524 },
        { lon: "-38.6", lat: "-12.9", name: "Vera Cruz", display_name: "Vera Cruz, Bahia", category: "boundary", importance: 0.522 },
      ],
      expect: { declined: "tie" },
    },
    {
      name: "a modern namesake far from every historical record is declined",
      place: "Tenochtitlan",
      body: [
        { lon: "-96.9420", lat: "19.8251", name: "Tenochtitlán", display_name: "Tenochtitlán, Veracruz, México", category: "boundary", importance: 0.373, boundingbox: ["19.75", "19.90", "-97.00", "-96.88"] },
      ],
      hints: { historical: [{ lon: -99.1314, lat: 19.435, displayName: "Tenochtitlan (TGN)" }] },
      expect: { declined: "contradicts historical gazetteers" },
    },
    {
      name: "a country is held to its extent, not its centroid (Peru, 360 km off-centre)",
      place: "Peru",
      body: [
        { lon: "-75.0459", lat: "-6.8700", name: "Perú", display_name: "Perú", category: "boundary", importance: 0.83, boundingbox: ["-18.35", "-0.04", "-81.33", "-68.65"], namedetails: { name: "Perú", "name:en": "Peru" } },
      ],
      hints: { historical: [{ lon: -76.0, lat: -10.0, displayName: "Peru (TGN)" }] },
      expect: { lon: -75.0459 },
    },
    {
      name: "a region within reach of its historical record is accepted",
      place: "New Mexico",
      body: [
        { lon: "-105.9960", lat: "34.5802", name: "New Mexico", display_name: "New Mexico, United States", category: "boundary", importance: 0.75 },
      ],
      hints: { historical: [{ lon: -106.045316, lat: 34.167167, displayName: "New Mexico (OHM)" }] },
      expect: { lon: -105.996 },
    },
    {
      name: "another language's name matches via namedetails (Mexico City → Ciudad de México)",
      place: "Mexico City",
      body: [
        { lon: "-99.1332", lat: "19.4326", name: "Ciudad de México", display_name: "Ciudad de México, México", category: "boundary", importance: 0.782, namedetails: { name: "Ciudad de México", "name:en": "Mexico City" } },
      ],
      expect: { lon: -99.1332 },
    },
    {
      name: "accents don't break the name match, and a 0.03 gap is not a tie (Yucatán)",
      place: "Yucatan",
      body: [
        { lon: "-88.8756", lat: "20.6846", name: "Yucatán", display_name: "Yucatán, México", category: "boundary", importance: 0.624 },
        { lon: "-89.0", lat: "19.5", name: "Península de Yucatán", display_name: "Península de Yucatán, México", category: "natural", importance: 0.594 },
      ],
      expect: { lon: -88.8756 },
    },
  ];
  for (const c of gateCases) {
    const mock = installFetchMock([{ status: 200, body: c.body }]);
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0 }),
      fakeRateLimiter(),
      fakeJevClient(),
    );
    const outcome = await geocoder.lookup(c.place, c.hints);
    check(
      c.name,
      "lon" in c.expect
        ? outcome.hit?.lon === c.expect.lon
        : outcome.hit === null &&
            (outcome.declined?.reason.startsWith(c.expect.declined) ?? false),
      outcome.hit
        ? JSON.stringify(outcome.hit)
        : (outcome.declined?.reason ?? "plain miss"),
    );
    mock.restore();
  }

  {
    // End to end through the tiers: WHG is ambiguous but knows where the
    // historical place is; Nominatim's confident-looking modern namesake
    // contradicts it; nothing is pinned and both reasons are kept.
    const mock = installFetchMock([
      {
        status: 200,
        body: {
          q0: {
            result: [
              { id: "place:tgn:7005077", name: "Tenochtitlan", score: 100, match: true, namespace: "tgn", description: "Country: MX", repr_point: [-99.1314, 19.435] },
              { id: "place:clio:1", name: "Tenochtitlan", score: 100, match: true, namespace: "clio", description: "Country: MX", repr_point: [-98.628, 19.186228] },
            ],
          },
        },
      },
      {
        status: 200,
        body: [
          { lon: "-96.9420", lat: "19.8251", name: "Tenochtitlán", display_name: "Tenochtitlán, Veracruz, México", category: "boundary", importance: 0.373 },
        ],
      },
    ]);
    const config = fakeConfig({
      WHG_API_TOKEN: "test-token",
      WHG_MIN_INTERVAL_MS: 0,
      GEOCODER_MIN_INTERVAL_MS: 0,
    });
    const tiers = new FallbackGeocoder([
      new WhgGeocoder(config, fakeRateLimiter()),
      new NominatimGeocoder(config, fakeRateLimiter(), fakeJevClient()),
    ]);
    const outcome = await tiers.lookup("Tenochtitlan");
    check(
      "WHG's historical hints reach Nominatim, which then declines its namesake",
      outcome.hit === null &&
        /whg: ambiguous/.test(outcome.declined?.reason ?? "") &&
        /nominatim: contradicts historical gazetteers/.test(
          outcome.declined?.reason ?? "",
        ),
      outcome.declined?.reason,
    );
    mock.restore();
  }

  // ── JEV_GEOCODE_RERANK_ENABLED ──────────────────────────────────────────
  // Three usable candidates, none tied on importance — without reranking,
  // `usable[0]` ("Old Fort Hamlet") always wins. These prove the flag
  // actually changes which one is picked, and that disabling it at any of
  // the three points that gate it (feature flag, client credentials, or a
  // failed/empty Jev call) reproduces the unmodified `usable[0]` behaviour.
  const RERANK_CANDIDATES_BODY = [
    {
      lon: "-111.1",
      lat: "40.1",
      name: "Old Fort Hamlet",
      display_name: "Old Fort Hamlet",
      category: "natural",
      importance: 0.5,
    },
    {
      lon: "-111.2",
      lat: "40.2",
      name: "Fort Hamlet",
      display_name: "Fort Hamlet (historic site)",
      category: "historic",
      importance: 0.4,
    },
    {
      lon: "-111.3",
      lat: "40.3",
      name: "New Fort Hamlet Estates",
      display_name: "New Fort Hamlet Estates",
      category: "natural",
      importance: 0.3,
    },
  ];

  {
    const mock = installFetchMock([{ status: 200, body: RERANK_CANDIDATES_BODY }]);
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0, JEV_GEOCODE_RERANK_ENABLED: true }),
      fakeRateLimiter(),
      fakeJevClient({ enabled: true, pick: 1 }),
    );
    const hit = await safeGeocode(
      geocoder,
      "Fort Hamlet",
      "reranking enabled resolves without throwing",
    );
    check(
      "flag on + credentials: Jev's pick (index 1) wins over usable[0]",
      hit?.displayName === "Fort Hamlet (historic site)",
      hit?.displayName,
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, body: RERANK_CANDIDATES_BODY }]);
    // Client has credentials but the flag itself is off.
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0, JEV_GEOCODE_RERANK_ENABLED: false }),
      fakeRateLimiter(),
      fakeJevClient({ enabled: true, pick: 1 }),
    );
    const hit = await safeGeocode(geocoder, "Fort Hamlet", "flag off resolves without throwing");
    check(
      "flag off (even with credentials) falls back to usable[0] unchanged",
      hit?.displayName === "Old Fort Hamlet",
      hit?.displayName,
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, body: RERANK_CANDIDATES_BODY }]);
    // Flag on, but the client reports no credentials (JEV_API_KEY unset).
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0, JEV_GEOCODE_RERANK_ENABLED: true }),
      fakeRateLimiter(),
      fakeJevClient({ enabled: false, pick: 1 }),
    );
    const hit = await safeGeocode(geocoder, "Fort Hamlet", "no credentials resolves without throwing");
    check(
      "flag on but client disabled falls back to usable[0] unchanged",
      hit?.displayName === "Old Fort Hamlet",
      hit?.displayName,
    );
    mock.restore();
  }

  {
    const mock = installFetchMock([{ status: 200, body: RERANK_CANDIDATES_BODY }]);
    // Flag on, credentials present, but the call itself failed/returned
    // nothing — `tryAsk`'s whole contract is to resolve to `null` here.
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0, JEV_GEOCODE_RERANK_ENABLED: true }),
      fakeRateLimiter(),
      fakeJevClient({ enabled: true, pick: null }),
    );
    const hit = await safeGeocode(geocoder, "Fort Hamlet", "a failed Jev call resolves without throwing");
    check(
      "a failed/empty Jev call falls back to usable[0], never breaks the geocode",
      hit?.displayName === "Old Fort Hamlet",
      hit?.displayName,
    );
    mock.restore();
  }

  {
    // Only one usable candidate — nothing to choose between, so `rerank`
    // must short-circuit before ever calling Jev.
    const mock = installFetchMock([
      {
        status: 200,
        body: [RERANK_CANDIDATES_BODY[0]],
      },
    ]);
    let askCalled = false;
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0, JEV_GEOCODE_RERANK_ENABLED: true }),
      fakeRateLimiter(),
      {
        enabled: true,
        tryAsk: async () => {
          askCalled = true;
          return null;
        },
      } as unknown as JevClient,
    );
    const hit = await safeGeocode(geocoder, "Fort Hamlet", "a single candidate resolves without throwing");
    check(
      "a single usable candidate never calls Jev at all",
      hit?.displayName === "Old Fort Hamlet" && !askCalled,
      `askCalled=${askCalled}`,
    );
    mock.restore();
  }

  // The confidence bar and the "none of these" outcome. All four runs have the
  // flag and credentials on and an otherwise-valid pick of index 1.
  const rerankCases: Array<{
    name: string;
    config: Record<string, string | number | boolean>;
    jev: Parameters<typeof fakeJevClient>[0];
    expect: string;
  }> = [
    {
      name: "Jev saying none of the results fit keeps Nominatim's top result",
      config: {},
      jev: { enabled: true, pick: "none" },
      expect: "Old Fort Hamlet",
    },
    {
      name: "a pick below the default 0.8 confidence bar keeps Nominatim's top result",
      config: {},
      jev: { enabled: true, pick: 1, confidence: 0.5 },
      expect: "Old Fort Hamlet",
    },
    {
      name: "a pick exactly at the confidence bar is trusted (inclusive)",
      config: {},
      jev: { enabled: true, pick: 1, confidence: 0.8 },
      expect: "Fort Hamlet (historic site)",
    },
    {
      name: "lowering JEV_GEOCODE_MIN_CONFIDENCE to 0.4 trusts the same 0.5 pick",
      config: { JEV_GEOCODE_MIN_CONFIDENCE: 0.4 },
      jev: { enabled: true, pick: 1, confidence: 0.5 },
      expect: "Fort Hamlet (historic site)",
    },
    {
      name: "JEV_GEOCODE_MIN_CONFIDENCE=0 always takes Jev's pick, however unsure",
      config: { JEV_GEOCODE_MIN_CONFIDENCE: 0 },
      jev: { enabled: true, pick: 1, confidence: 0.01 },
      expect: "Fort Hamlet (historic site)",
    },
  ];
  for (const c of rerankCases) {
    const mock = installFetchMock([{ status: 200, body: RERANK_CANDIDATES_BODY }]);
    const geocoder = new NominatimGeocoder(
      fakeConfig({ GEOCODER_MIN_INTERVAL_MS: 0, JEV_GEOCODE_RERANK_ENABLED: true, ...c.config }),
      fakeRateLimiter(),
      fakeJevClient(c.jev),
    );
    const hit = await safeGeocode(geocoder, "Fort Hamlet", `${c.name} (resolves)`);
    check(c.name, hit?.displayName === c.expect, hit?.displayName);
    mock.restore();
  }

  // ── Jev context tier (decideWithContext) ────────────────────────────────
  // "Tepeyacac" as the tiers saw it on 2026-10-14: WHG's single match is a
  // village in Puebla; the hill of Tepeyac in Mexico City is in the pool only
  // as an unmatched record. The event is the Virgin of Guadalupe apparition.
  const PUEBLA = { lon: -96.99966, lat: 18.31575, displayName: "Tepeyacac (Country: MX)" };
  const TEPEYAC_HILL = { lon: -99.115782, lat: 19.486832, displayName: "Tepeyac Hill (Country: MX)" };
  const tepeyacac: GeocodeOutcome = {
    hit: { ...PUEBLA, provider: "whg" },
    considered: [PUEBLA, TEPEYAC_HILL],
  };
  const apparition = {
    title: "Apparition of the Virgin of Guadalupe",
    description: "Juan Diego reports the Virgin appearing on the hill of Tepeyacac, north of the city.",
  };
  /** A Jev that answers the `place` question with `choice` at `confidence`; null = failed call. */
  const contextJev = (choice: string | null, confidence = 0.9): JevClient =>
    ({
      enabled: true,
      tryAsk: async () =>
        choice === null ? null : { place: { type: "choice", choice, confidence } },
    }) as unknown as JevClient;

  {
    const decided = await decideWithContext(contextJev("place_1", 0.9), {
      placeName: "Tepeyacac",
      outcome: tepeyacac,
      context: apparition,
      threshold: 0.8,
    });
    check(
      "a confident pick of a different place replaces the tiers' answer (Tepeyacac → Tepeyac Hill)",
      decided?.hit?.lon === TEPEYAC_HILL.lon &&
        decided.hit.provider === "jev" &&
        decided.confidence === 0.9 &&
        decided.decision.applied === true,
      JSON.stringify(decided?.hit),
    );
    check(
      "the decision records the tiers' answer, the pick, the threshold and the event",
      decided?.decision.tierHit?.lon === PUEBLA.lon &&
        decided.decision.picked?.lon === TEPEYAC_HILL.lon &&
        decided.decision.threshold === 0.8 &&
        decided.decision.context.title === apparition.title &&
        decided.decision.candidates.length === 2,
      JSON.stringify(decided?.decision),
    );
  }

  {
    const decided = await decideWithContext(contextJev("place_1", 0.6), {
      placeName: "Tepeyacac",
      outcome: tepeyacac,
      context: apparition,
      threshold: 0.8,
    });
    check(
      "a pick below the threshold keeps the tiers' answer, but is still recorded",
      decided?.hit?.lon === PUEBLA.lon &&
        decided.confidence === null &&
        decided.decision.applied === false &&
        decided.decision.picked?.lon === TEPEYAC_HILL.lon,
      JSON.stringify(decided?.decision),
    );
  }

  {
    const decided = await decideWithContext(contextJev("place_1", 0.6), {
      placeName: "Tepeyacac",
      outcome: tepeyacac,
      context: apparition,
      threshold: 0.5,
    });
    check(
      "the threshold is the caller's (confidence_thresholds), not a constant",
      decided?.hit?.lon === TEPEYAC_HILL.lon && decided.decision.threshold === 0.5,
      JSON.stringify(decided?.decision),
    );
  }

  {
    const decided = await decideWithContext(contextJev("place_0", 0.95), {
      placeName: "Tepeyacac",
      outcome: tepeyacac,
      context: apparition,
      threshold: 0.8,
    });
    check(
      "agreeing with the tiers keeps their pin and records Jev's confidence in it",
      decided?.hit?.lon === PUEBLA.lon &&
        decided.hit.provider === "whg" &&
        decided.confidence === 0.95 &&
        decided.decision.applied === false,
      JSON.stringify(decided?.decision),
    );
  }

  {
    const declined: GeocodeOutcome = {
      hit: null,
      declined: { provider: "fallback", reason: "whg: ambiguous", candidates: [PUEBLA, TEPEYAC_HILL] },
    };
    const decided = await decideWithContext(contextJev("place_1", 0.85), {
      placeName: "Tepeyacac",
      outcome: declined,
      context: apparition,
      threshold: 0.8,
    });
    check(
      "a confident pick places an event the tiers declined",
      decided?.hit?.lon === TEPEYAC_HILL.lon && decided.decision.tierHit === null,
      JSON.stringify(decided?.hit),
    );
  }

  {
    const decided = await decideWithContext(contextJev("none", 0.99), {
      placeName: "Tepeyacac",
      outcome: tepeyacac,
      context: apparition,
      threshold: 0.8,
    });
    check(
      '"none of these" never invents a pin — the tiers\' answer stands',
      decided?.hit?.lon === PUEBLA.lon &&
        decided.decision.picked === null &&
        decided.confidence === null,
      JSON.stringify(decided?.decision),
    );
  }

  {
    const decided = await decideWithContext(contextJev(null), {
      placeName: "Tepeyacac",
      outcome: tepeyacac,
      context: apparition,
      threshold: 0.8,
    });
    check("a failed Jev call returns null, leaving the tiers' outcome untouched", decided === null);
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
      const geocoder = new WhgGeocoder(
        {
          get: (key: string) => process.env[key],
        } as unknown as ConfigService,
        fakeRateLimiter(),
      );

      for (const place of [
        "Sutter's Mill",
        "Promontory Summit",
        "Nonexistent Place Zzyzx123",
      ]) {
        const result = await expectRejects(async () => {
          const hit = await geocoder.geocode(place);
          console.log(`  "${place}" ->`, hit);
        });
        check(
          `live geocode("${place}") does not throw`,
          !result.threw,
          result.message,
        );
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
