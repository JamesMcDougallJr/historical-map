/**
 * Checks the ingestion fixture's reset guard. No database, no network.
 *
 *   npm run fixture-guard:verify --workspace=services/ingest
 *
 * The guard exists because the fixture once wiped a dev database's events and
 * sequences (see `fixture-guard.ts`), so what matters here is that it says
 * "no" to everything that is not unmistakably the fixture's own data.
 */
import { foreignFixtureData } from "./fixture-guard";

const checks: Array<[string, boolean, string?]> = [];
const check = (name: string, ok: boolean, detail?: string): void => {
  checks.push([name, ok, detail]);
};

const FIXTURE_DOCS = [{ external_id: "fixture-one.txt" }, { external_id: "fixture-two.txt" }];

check("an empty database is safe to reset", foreignFixtureData([], []).length === 0);

check(
  "only fixture documents and events published from them is safe (a previous fixture run)",
  foreignFixtureData(FIXTURE_DOCS, [
    { document_external_id: "fixture-one.txt", n: 4 },
    { document_external_id: "fixture-two.txt", n: 4 },
  ]).length === 0,
);

{
  const problems = foreignFixtureData(
    [...FIXTURE_DOCS, { external_id: "Personal Memoirs of U.S. Grant Vol I.pdf" }],
    [],
  );
  check(
    "a real document is refused, and named",
    problems.length === 1 && problems[0]!.includes("Personal Memoirs of U.S. Grant"),
    JSON.stringify(problems),
  );
}

{
  const problems = foreignFixtureData([], [{ document_external_id: "grant.pdf", n: 59 }]);
  check(
    "local-directory events from a real document are refused, with their count",
    problems.length === 1 && problems[0]!.includes("59"),
    JSON.stringify(problems),
  );
}

{
  const problems = foreignFixtureData([], [{ document_external_id: null, n: 7 }]);
  check(
    "local-directory events whose document is gone are refused (cannot be attributed)",
    problems.length === 1 && problems[0]!.includes("7"),
    JSON.stringify(problems),
  );
}

check(
  "a fixture document does not excuse real events alongside it",
  foreignFixtureData(FIXTURE_DOCS, [
    { document_external_id: "fixture-one.txt", n: 4 },
    { document_external_id: "grant.pdf", n: 2 },
  ]).length === 1,
);

check(
  "both kinds of foreign data are reported together",
  foreignFixtureData(
    [{ external_id: "grant.pdf" }],
    [{ document_external_id: null, n: 3 }],
  ).length === 2,
);

let failed = 0;
for (const [name, ok, detail] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
if (failed > 0) process.exitCode = 1;
