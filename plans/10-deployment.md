# Phase 10 — Deployment · **Implemented**

Per-app Dockerfiles (build context is the **repo root**, since the workspace
root owns the lockfile and `packages/domain` ships TS source webpack must
compile in), `docker-compose.prod.yml` layered on the dev compose, and a
one-shot `migrate` init-container every worker gates on — so a fresh database
cannot crash-loop five workers racing to migrate it.

Bull Board is mounted at `/queues` **behind HTTP Basic auth that fails closed**:
with no `BULL_BOARD_PASSWORD` it returns 503 rather than mounting openly. The
pipeline this is modelled on left it unauthenticated, which is fine on
localhost and not fine anywhere reachable — it exposes every job payload and a
Remove button on each one.

The web app is on Vercel. **The workers cannot be**, and that constraint shapes this phase.

## Why not Vercel

Vercel functions are request-scoped and short-lived. BullMQ workers are long-lived processes
holding a persistent Redis connection and a blocking poll — the opposite shape. Neither Vercel
Cron nor a fluent-looking serverless queue wrapper changes that: a job that runs for minutes,
retries with exponential backoff, and must survive a restart wants a process, not an invocation.

So the deployment is **split**: web app on Vercel, workers on a host that runs containers, one
Postgres shared between them.

```
        Vercel                       Container host
   ┌──────────────┐              ┌──────────────────────┐
   │ Next.js app  │              │ api                  │
   │ /map, /api/* │              │ detect fetch         │
   └──────┬───────┘              │ extract publish      │
          │                      └────────┬──────┬──────┘
          │                               │      │
          └──────────► Postgres ◄─────────┘    Redis
```

Postgres is the integration point. The workers write; the web app reads what it already reads.
There is no service-to-service API between them, deliberately — one less thing to authenticate,
version, and page someone about.

## Where the workers run · **Decided**

The workers run **locally**, on the operator's own machine, via the existing `docker-compose.yml`
— not a VPS. This is a deliberate cost decision (avoid paying for a host running the "opposite
shape from serverless" workload described above), not an oversight of the options table that used
to live here. Redis and object storage (MinIO) stay local too — nothing about the worker host
needs to be reachable from the internet, since Postgres is the only integration point and the
workers only ever *write* to it.

## Where Martin runs · **Decided**

`app/map` renders event layers as live MVT tiles instead of static GeoJSON purely based on whether
`NEXT_PUBLIC_MARTIN_URL` is set (`app/map/utils/event-layers.ts`) — so Martin (`docker-compose.yml`'s
`martin` service) is the one piece besides Postgres that needs a stable **public** HTTPS URL, since
the Vercel-hosted browser fetches tiles from it directly.

Current: **ECS Fargate behind an ALB behind CloudFront** (`infra/`, Terraform), ~$40–50/mo, torn
down with `terraform destroy`. The original plan was Lightsail Container Service (a single
stateless container, no load balancer needed, ~$7/mo) — abandoned after a real deploy attempt
found this account's Container Service quota is 0 (confirmed empty across every Lightsail region;
AWS still rejects creating the first one as exceeding the limit, which needs an AWS Support
quota-increase request, not something scriptable). CloudFront exists specifically because a plain
ALB can't get a browser-trusted HTTPS cert without a custom domain, and Vercel serves the map over
HTTPS — an HTTP-only tile endpoint is blocked as mixed content, not just insecure.
Deliberately an interim step regardless of which of these it ends up being: once self-hosting is
set up, Martin moves to the same local machine as the workers, exposed via a Cloudflare Tunnel,
and this whole stack goes away — the only thing that changes elsewhere is `NEXT_PUBLIC_MARTIN_URL`
in Vercel. Full apply/verify/teardown walkthrough — including the confirmed-working
`tofu apply` → seed → curl-verified MVT tiles → `tofu destroy` cycle — is in `infra/README.md`.

## Where Postgres runs · **Decided**

**AWS RDS for PostgreSQL** (`infra/`, Terraform), not the container-on-the-worker-host option this
section used to weigh — `POSTGRES_URL` needs to be reachable from both Vercel (build+runtime) and
Martin, so it has to be public regardless of where the workers themselves live.
RDS Postgres supports `CREATE EXTENSION postgis`, which `lib/postgres-storage.ts`'s `ensureSchema()`
requires. `publicly_accessible = true` with `0.0.0.0/0` ingress is a stated demo-grade tradeoff
(Vercel serverless functions have no fixed egress IP without paid Secure Compute) — see
`infra/README.md` for the mitigations (`sslmode=require` enforced server-side, generated password).

## Configuration

`POSTGRES_URL` must be **the same database** on both sides. It is the single most important
configuration fact in the deployment and the one most likely to be got wrong — a worker
pointed at a different database ingests happily into a void, with no error anywhere.

Worker-only secrets (`ANTHROPIC_API_KEY`, geocoder credentials) belong only on the container
host. There is no reason for the Vercel project to hold them, and good reason not to.

## Observability

- **Bull Board** for queue state, behind auth. Not optional — "why has nothing appeared on the
  map" is otherwise unanswerable without shell access.
- Structured logs via the dual-transport `JobLogger` (phase 6), so per-job logs are visible in
  both `docker logs` and Bull Board.
- A single alert worth having on day one: **queue depth growing monotonically**. It catches a
  dead worker, a wedged job, and an upstream outage with one signal.

## Operational scripts

Port the State Affairs `scripts/` set — they exist because each was needed at 2am:
`queue-inspect`, `queue-requeue`, `sources-verify`, `db-verify`. Add them as workspace scripts
so they run from the repo root.

## Cost

Roughly: VPS (~$10–20/mo) + Redis (on the same box) + Claude API. The API is the variable, and
phase 8's controls — never re-extracting unchanged documents, the cheap pre-filter, and the
Batches API for backfill — are what keep it bounded. Backfilling a large archive is a one-time
spike worth estimating *before* running rather than discovering on an invoice.
