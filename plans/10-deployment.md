# Phase 10 — Deployment

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

## Where the workers run

| Option | For | Against |
|---|---|---|
| **Single VPS / EC2 + Docker Compose** | Cheapest, most control, and the compose file already exists for local dev — one artefact for both. The State Affairs choice. | Manual provisioning; you own the host. |
| **Fly.io / Railway** | Managed containers, managed Postgres and Redis add-ons, near-zero ops. | Less control; another bill. |
| **ECS/Fargate** | Scales properly. | Adds moving parts this workload's actual volume does not justify. |

Recommendation: **a single small VPS running the existing compose stack**, extended with the
Redis and worker services from phase 2. Ingestion volume here is a handful of documents per
source per day at steady state — this is not a workload that needs an orchestrator, and the
same compose file serving dev and prod is a real simplification.

Decide before phase 10 whether production Postgres is the **existing Vercel/managed Postgres**
(simplest — one database, already backed up, already what the app reads) or a container on the
same host (cheaper, but now you own backups). Recommendation: keep the managed one and point
the workers at it.

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
