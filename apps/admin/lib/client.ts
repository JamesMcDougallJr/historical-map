// Cross-origin, unlike the main app's own use of this client: NEXT_PUBLIC_MAP_APP_URL
// must point at wherever the main app is running (e.g. http://localhost:3000),
// and NEXT_PUBLIC_MAP_API_KEY must match that app's MAP_API_KEY.

import { createMapClient } from "@historical-map/api-client";

export const mapClient = createMapClient({
  baseUrl: process.env["NEXT_PUBLIC_MAP_APP_URL"] ?? "http://localhost:3000",
  apiKey: process.env["NEXT_PUBLIC_MAP_API_KEY"],
});
