# infra — RDS + Martin (ECS Fargate / ALB / CloudFront)

Provisions the two pieces that need a stable public home for the Vercel demo
to show live event layers: an RDS Postgres instance (PostGIS-capable) and
Martin (the MVT tile server), fronted by an ALB and CloudFront for HTTPS. The
ingest workers stay local — nothing here provisions them. See
`plans/10-deployment.md` for the full picture.

Terraform, on purpose, so the whole stack tears down with one command when
this moves to self-hosting.

**Not Lightsail Container Service**, despite that being the original plan:
this account's Container Service quota is 0 — confirmed empty across every
Lightsail region, yet AWS still rejects creating the very first one as
"exceeding your maximum limit." That requires an AWS Support quota-increase
request, not something Terraform or the CLI can push through. ECS Fargate
needs no such request.

## Architecture

```
Vercel (HTTPS) ──▶ CloudFront (HTTPS, *.cloudfront.net, AWS-managed cert)
                        │
                        ▼
                   ALB (HTTP only, security group allows CloudFront's
                        edge IPs only — not the whole internet)
                        │
                        ▼
                   ECS Fargate task running Martin ──▶ RDS Postgres
```

A plain ALB can't get a browser-trusted HTTPS certificate without owning a
custom domain (ACM won't issue certs for the ALB's own `*.elb.amazonaws.com`
name), and Vercel serves the map over HTTPS — an HTTP-only tile endpoint gets
blocked outright as mixed content. CloudFront exists purely to solve that
with no domain purchase required.

## Prerequisites

- `terraform >= 1.5` (or OpenTofu, which is what this was actually validated
  with — see below), `aws` CLI, authenticated
- An AWS account with billing set up. Cost, running 24/7: RDS `db.t4g.micro`
  (~$12–15/mo, or free-tier eligible for 12mo on a newer account) + ~$2.3/mo
  storage + ALB (~$16–20/mo, the dominant cost here) + Fargate 0.25vCPU/0.5GB
  task (~$9–10/mo) + CloudFront (~$1–2/mo at demo traffic, often within the
  free tier). Roughly **$40–50/mo** — noticeably more than Lightsail's ~$19/mo
  combined total would have been, which is the real price of not needing the
  Container Service quota.

`terraform` was pulled from `homebrew-core` after HashiCorp's 2023 license
change; `brew install opentofu` gets a drop-in-compatible CLI (`tofu`
instead of `terraform`) if you don't already have the real thing via
`hashicorp/tap/terraform`. Every command below works with either, just swap
the binary name.

## Apply

One step now — unlike Lightsail, Fargate pulls `martin_source_image`
(`ghcr.io/maplibre/martin:1.16.0`) directly from GHCR, no local docker
pull/push dance required:

```bash
cd infra
tofu init
tofu plan -out=step1.tfplan
tofu apply step1.tfplan
```

RDS takes ~7–8 minutes to come up; everything else is fast. **Martin's first
task will crash-loop** until the database has PostGIS installed — see
"Seed it once" below, which must run before the ECS service reports healthy.

## Wire up Vercel

`vercel.tf` sets `POSTGRES_URL` and the documents bucket's `S3_*` variables on
the Vercel project directly from this stack's resources, so `tofu apply` needs
a Vercel token alongside your AWS credentials:

```bash
export VERCEL_API_TOKEN=...   # vercel.com/account/tokens, scoped to the team
tofu apply
```

An env var change does **not** redeploy — push to `main` (or redeploy in the
dashboard) for a running site to pick it up.

`NEXT_PUBLIC_MARTIN_URL` is deliberately not managed: it switches `/map` from
GeoJSON pins to Martin MVT tiles, and the live site currently runs without it.
To turn tiles on, set it from `tofu output martin_url` — it is build-time,
inlined into the client bundle.

## Seed it once

From the repo root, against `postgres_url` above:
```bash
POSTGRES_URL="$(tofu -chdir=infra output -raw postgres_url)" npm run migrate --workspace=services/ingest
POSTGRES_URL="$(tofu -chdir=infra output -raw postgres_url)" npm run seed:db
```
`seed:db` creates the map schema (including `CREATE EXTENSION postgis`,
which Martin needs at startup or it exits immediately — this is why the
first task crash-loops before this step runs) and applies
`db/martin-functions.sql`'s `event_pins()` function, which Martin
auto-discovers and serves tiles from.

If Martin's ECS task started before this ran, force it to retry rather than
waiting out the crash-loop backoff:
```bash
aws ecs update-service --cluster historical-map-cluster \
  --service historical-map-martin --force-new-deployment --region us-east-1
```

## Verify

```bash
MARTIN_URL="$(tofu -chdir=infra output -raw martin_url)"
curl "$MARTIN_URL/catalog"           # confirms Martin found event_pins in Postgres
curl "$MARTIN_URL/event_pins/0/0/0"  # MVT bytes (application/x-protobuf), not an error

# The ALB itself is deliberately unreachable directly — its security group
# only allows CloudFront's edge IPs. Debug via CloudWatch instead:
aws logs tail /ecs/historical-map-martin --region us-east-1 --follow
```

## Teardown

```bash
tofu destroy
```
That's the entire point of this being Terraform rather than a sequence of
`aws` CLI commands — one command, no orphaned resources to hunt down across
the RDS, ECS, ALB, and CloudFront consoles. **`tofu destroy` can take several
minutes** (CloudFront distribution deletion is the slow part) — if a
destroy gets interrupted partway, the saved plan (if any) goes stale; just
re-run `tofu destroy` directly rather than reusing an old plan file.

## Notes on the choices made here

- **`rds_allowed_cidr_blocks` defaults to `0.0.0.0/0`.** Vercel serverless
  functions have no fixed egress IP without paid Secure Compute, so an IP
  allowlist isn't practical. Mitigated by `sslmode=require` (enforced
  server-side via `aws_db_parameter_group.postgres`'s `rds.force_ssl=1`,
  not just the client-side connection string) and a generated 32-character
  password. This is a demo-grade tradeoff, stated plainly rather than hidden
  — revisit if this stops being a demo.
- **The ALB's security group only allows CloudFront's managed prefix list**
  (`com.amazonaws.global.cloudfront.origin-facing`), not `0.0.0.0/0` — there
  is no reason to accept traffic at the ALB that didn't come through
  CloudFront, and this is free to get right.
- **No NAT gateway.** The Fargate task runs in a public subnet with a public
  IP directly (`assign_public_ip = true`) rather than a private subnet behind
  a NAT gateway — a NAT gateway alone runs ~$32/mo, more than every other
  piece of this stack combined, for a workload that has no secrets to hide
  behind one.
- **CloudFront caching is disabled** (`Managed-CachingDisabled` +
  `Managed-AllViewer`). Martin's tiles are filtered by
  `from_year`/`to_year`/`source_ids` query params
  (`mvtQueryString()` in `app/map/utils/event-layers.ts`) — a cache keyed
  wrong would serve one filter's tiles under another's URL.
- **State is local, gitignored, and holds the DB password in plaintext**
  (`random_password.db_master`, referenced in the `postgres_url` output).
  Never commit `*.tfstate*`. Move to an encrypted S3 backend if this stops
  being a single-operator project.
- **`skip_final_snapshot = true`** on the RDS instance — intentional, so
  `terraform destroy` doesn't leave a snapshot behind to notice on a bill
  later. There's nothing in this database that isn't reproducible from
  `data/map-data.json` + re-running ingest.

## Semantic-search pieces (plans/23-search-semantic.md)

Declared here, not yet applied:

- **RDS version** follows the newest PostgreSQL 16 minor
  (`data.aws_rds_engine_version`) instead of a hand pin — pgvector 0.8 needs
  ≥ 16.5. The upgrade happens in the instance's maintenance window
  (`apply_immediately = false`), not on `tofu apply`; `tofu output
  rds_engine_version` shows the target.
- **Bedrock** (`bedrock.tf`): a web-app IAM user allowed only
  `bedrock:InvokeModel` on Titan Embed v2 in us-west-2. `vercel.tf` passes its
  key to Vercel as `BEDROCK_ACCESS_KEY_ID`/`BEDROCK_SECRET_ACCESS_KEY` (not
  `AWS_*`, which Vercel reserves), with `BEDROCK_REGION` and `EMBEDDING_MODEL`.
- **CI** (`github-oidc.tf`): this repository's workflows get the same one-model
  permission through a GitHub OIDC role — no long-lived secret — published as
  the `AWS_EMBEDDINGS_ROLE_ARN` Actions variable. Needs `GITHUB_TOKEN` (repo
  admin) in the environment at apply. An account allows one GitHub OIDC
  provider; if it already has one, set `github_oidc_provider_arn`. Setting
  `github_repository = ""` skips all of it.
- **Budget** (`budgets.tf`): set `alert_email` (in `terraform.tfvars`) to get a
  Bedrock-only monthly budget, emailing at 80% of
  `bedrock_monthly_budget_usd` actual and 100% forecast.

## Checks

`tofu fmt -check`, `tofu validate` and `tofu test` run in CI
(`.github/workflows/infra.yml`) with no credentials: `tests/` plans the whole
stack against mocked providers and asserts the properties that matter
(one-model IAM policy, repository-scoped OIDC trust, maintenance-window
upgrade, budget filter, the Vercel env set). Locally:

```bash
tofu init -backend=false && tofu validate && tofu test
```
