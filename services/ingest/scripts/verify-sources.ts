/**
 * Exercises the local-directory source and every parser against real fixtures
 * written to a throwaway directory. No network, no database, no Redis.
 *
 *   npm run sources:verify --workspace=services/ingest
 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HtmlParser, PdfParser, TextParser } from "../libs/parsers/src";
import { LocalDirectoryAdapter } from "../libs/sources/src";

const checks: Array<[string, boolean, string?]> = [];
function check(name: string, ok: boolean, detail?: string): void {
  checks.push([name, ok, detail]);
}

/**
 * A hand-built two-page PDF. pdf.js recovers from a missing xref table, which
 * is why this works without a generator dependency — enough to prove the
 * one-segment-per-page contract without committing a binary fixture.
 */
function minimalPdf(): Buffer {
  const page = (n: number, body: string) => `${n} 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${n + 1} 0 R/Resources<</Font<</F1 7 0 R>>>>>>
endobj
${n + 1} 0 obj
<</Length ${body.length}>>
stream
${body}
endstream
endobj
`;
  const c1 = "BT /F1 24 Tf 72 700 Td (Gold Rush began in 1849) Tj ET";
  const c2 = "BT /F1 24 Tf 72 700 Td (Promontory Summit May 10, 1869) Tj ET";
  return Buffer.from(
    `%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R 5 0 R]/Count 2>>
endobj
${page(3, c1)}${page(5, c2)}7 0 obj
<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>
endobj
trailer
<</Root 1 0 R/Size 8>>
%%EOF
`,
    "latin1",
  );
}

const HTML_FIXTURE = `<!doctype html>
<html><head><title>T</title><style>.x{color:red}</style></head>
<body>
  <nav><a href="/">Home</a><a href="/about">About NAVIGATION_JUNK</a></nav>
  <header>SITE_BANNER_JUNK</header>
  <p>Intro paragraph before any heading.</p>
  <h2>The Gold Rush</h2>
  <p>Gold was found at Sutter's Mill in 1848.</p>
  <h2>The Railroad</h2>
  <p>The rails met at Promontory Summit on May 10, 1869.</p>
  <footer>FOOTER_JUNK &copy; 2026</footer>
  <script>var COOKIE_BANNER_JUNK = 1;</script>
</body></html>`;

const TEXT_FIXTURE = `First paragraph about 1847.

Second paragraph about 1850.

Third paragraph.`;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "corpus-"));

  try {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "book.pdf"), minimalPdf());
    await writeFile(join(root, "article.html"), HTML_FIXTURE);
    await writeFile(join(root, "nested", "notes.txt"), TEXT_FIXTURE);
    await writeFile(join(root, "ignored.xlsx"), "not a document");
    await writeFile(join(root, ".hidden.txt"), "should be skipped");

    // ── Source ────────────────────────────────────────────────────────────
    const adapter = new LocalDirectoryAdapter(root);
    const docs = await adapter.fetchAvailableDocuments(new Set());

    check(
      "discovers only supported extensions (3 of 5 files)",
      docs.length === 3,
      `got ${docs.length}: ${docs.map((d) => d.externalId).join(", ")}`,
    );
    check(
      "externalId is a POSIX-style relative path",
      docs.some((d) => d.externalId === "nested/notes.txt"),
      docs.map((d) => d.externalId).join(", "),
    );
    check(
      "every document carries a sha256 etag",
      docs.every((d) => /^[a-f0-9]{64}$/.test(d.etag ?? "")),
    );
    check(
      "content types derived from extension",
      docs.find((d) => d.externalId === "book.pdf")?.contentType ===
        "application/pdf",
    );

    // Re-scan is stable — the same identifiers, so the DB unique index dedupes.
    const rescan = await adapter.fetchAvailableDocuments(new Set());
    check(
      "re-scan yields identical externalIds and etags",
      JSON.stringify(rescan.map((d) => [d.externalId, d.etag])) ===
        JSON.stringify(docs.map((d) => [d.externalId, d.etag])),
    );

    // Editing a file changes only that document's hash — the local 304 signal.
    await writeFile(
      join(root, "nested", "notes.txt"),
      TEXT_FIXTURE + "\n\nNew.",
    );
    const afterEdit = await adapter.fetchAvailableDocuments(new Set());
    const before = docs.find((d) => d.externalId === "nested/notes.txt")!;
    const after = afterEdit.find((d) => d.externalId === "nested/notes.txt")!;
    const others =
      JSON.stringify(
        afterEdit
          .filter((d) => d.externalId !== "nested/notes.txt")
          .map((d) => d.etag),
      ) ===
      JSON.stringify(
        docs
          .filter((d) => d.externalId !== "nested/notes.txt")
          .map((d) => d.etag),
      );
    check("edited file changes its etag", before.etag !== after.etag);
    check("edit leaves other documents' etags untouched", others);

    const missing = new LocalDirectoryAdapter(join(root, "does-not-exist"));
    check(
      "missing corpus dir yields [] rather than throwing",
      (await missing.fetchAvailableDocuments(new Set())).length === 0,
    );

    // ── Parsers ───────────────────────────────────────────────────────────
    const pdf = await new PdfParser().parse(minimalPdf());
    check(
      "PDF yields one segment per page",
      pdf.segments.length === 2,
      `segments: ${pdf.segments.length} -> ${pdf.segments.map((s) => s.anchor).join(",")}`,
    );
    check(
      "PDF segments anchored by page number",
      pdf.segments[0]?.anchor === "p.1" && pdf.segments[1]?.anchor === "p.2",
    );
    check("PDF text extracted", /1849/.test(pdf.text) && /1869/.test(pdf.text));

    const html = await new HtmlParser().parse(Buffer.from(HTML_FIXTURE));
    // The change from the web route's version: chrome is deleted, not
    // newline-separated, so none of this survives into the token budget.
    const junk = [
      "NAVIGATION_JUNK",
      "SITE_BANNER_JUNK",
      "FOOTER_JUNK",
      "COOKIE_BANNER_JUNK",
    ];
    const leaked = junk.filter((j) => html.text.includes(j));
    check(
      "HTML chrome is deleted, not just newline-separated",
      leaked.length === 0,
      leaked.length ? `leaked: ${leaked.join(", ")}` : undefined,
    );
    check("HTML keeps real content", html.text.includes("Sutter's Mill"));
    check(
      "HTML segments on headings, with a preamble",
      html.segments.length === 3 && html.segments[0]?.anchor === "§preamble",
      html.segments.map((s) => s.anchor).join(" | "),
    );
    check("HTML entities decoded", !html.text.includes("&copy;"));

    const text = await new TextParser().parse(Buffer.from(TEXT_FIXTURE));
    check(
      "text segments on blank lines",
      text.segments.length === 3,
      `got ${text.segments.length}`,
    );

    // Empty input is a legitimate terminal state, not a crash — `fetch` turns
    // this into status `skipped` rather than burning the retry budget.
    const empty = await new TextParser().parse(Buffer.from("   \n\n  "));
    check(
      "empty document parses to zero segments",
      empty.segments.length === 0 && empty.text === "",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
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
