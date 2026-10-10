# Real-backend E2E suite

Separate from `e2e/` (mocked, `playwright.config.ts`, unchanged by this suite). This
one runs against the real local stack: Postgres, Martin-served MVT tiles, the real
`/map` and `apps/admin` Next.js apps.

## Before running locally

**This truncates and reseeds your local dev database.** There is no separate "test"
database — Martin's `DATABASE_URL` in `docker-compose.yml` is hardcoded to the same
`db` database `npm run dev` uses, so this suite reuses it. If you have local map data
you care about, back it up first:

```bash
npm run db:backup
```

## Running

```bash
docker compose up -d db martin
POSTGRES_URL=postgres://postgres:password@localhost:5433/db \
  npm run migrate --workspace=services/ingest   # search fixtures seed document_passages
ALLOW_TEST_DB_RESET=1 npm run test:e2e:real
```

`global-setup.ts` resets and reseeds the database before any test runs — the
`ALLOW_TEST_DB_RESET=1` guard is deliberate friction against running this against
anything other than a database you've chosen to point it at.

## Admin app port

`apps/admin`'s own `dev`/`start` scripts default to port 3001, which collides with
Martin's host port in `docker-compose.yml`. `e2e-real/playwright.config.ts` overrides
this at invocation time (`-p 3011`) rather than changing admin's own default, which
every developer running it standalone still expects.

## Ingestion fixture test

A separate, non-Playwright check — `services/ingest/scripts/run-ingestion-fixture.ts`
— runs the full detect → publish pipeline with a fake `ExtractionEngine` against a
tiny fixture corpus. It resets only the `ingest_*` tables (not
`sources`/`locations`/`events`), so it's safe to run before or after this suite:

```bash
docker compose up -d db redis minio minio-init
npm run migrate --workspace=services/ingest
ALLOW_TEST_DB_RESET=1 EXTRACTION_ENGINE=fake npm run test:ingestion-fixture --workspace=services/ingest
```

## Don't run alongside the mocked suite

Both this config and the root `playwright.config.ts` bind port 3000 for the web
app's `webServer`. Run them as separate, sequential steps.
