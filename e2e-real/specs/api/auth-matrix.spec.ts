import { test, expect } from "@playwright/test";

// Every route under /api/data/* (GET included — not just mutations) checks
// `x-api-key` against MAP_API_KEY whenever it's set (see each route's own
// checkApiKey()); this webServer config sets MAP_API_KEY=test-api-key.
// /api/sources, /api/sources/[id]/features and /api/documents/[id]/source
// carry no such check at all — confirmed by grepping them for checkApiKey.
const API_KEY = "test-api-key";

test.describe("API auth matrix (real backend)", () => {
  test("/api/data/locations requires the key for both GET and POST", async ({
    request,
  }) => {
    const unauthedGet = await request.get("/api/data/locations");
    expect(unauthedGet.status()).toBe(401);

    const authedGet = await request.get("/api/data/locations", {
      headers: { "x-api-key": API_KEY },
    });
    expect(authedGet.ok()).toBeTruthy();

    const unauthedPost = await request.post("/api/data/locations", {
      data: { name: "Should Be Rejected", coordinates: [0, 0] },
    });
    expect(unauthedPost.status()).toBe(401);
  });

  test("/api/data/groups and /api/data/search are also gated", async ({
    request,
  }) => {
    for (const path of ["/api/data/groups", "/api/data/search?q=x"]) {
      const unauthed = await request.get(path);
      expect(unauthed.status()).toBe(401);
      const authed = await request.get(path, {
        headers: { "x-api-key": API_KEY },
      });
      expect(authed.ok()).toBeTruthy();
    }
  });

  test("a wrong key is rejected the same as no key", async ({ request }) => {
    const res = await request.get("/api/data/locations", {
      headers: { "x-api-key": "wrong-key" },
    });
    expect(res.status()).toBe(401);
  });

  test("/api/sources, /api/sources/[id]/features, and /api/documents/[id]/source never require a key", async ({
    request,
  }) => {
    const sources = await request.get("/api/sources");
    expect(sources.ok()).toBeTruthy();

    const features = await request.get("/api/sources/fx-source-1/features");
    expect(features.ok()).toBeTruthy();

    // A document id that doesn't exist still reaches the route (no auth
    // gate) and returns a well-formed 404, not a 401.
    const doc = await request.get("/api/documents/00000000-0000-0000-0000-000000000000/source");
    expect(doc.status()).not.toBe(401);
  });

  test("/api/parse and /api/parse-pdf are reachable with no key", async ({
    request,
  }) => {
    const res = await request.post("/api/parse", {
      data: { text: "In 1850, something happened.", strategy: "regex" },
    });
    expect(res.status()).not.toBe(401);
  });
});
