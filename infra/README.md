# infra — RDS + Lightsail (Martin)

Provisions the two pieces that need a stable public home for the Vercel demo
to show live event layers: an RDS Postgres instance (PostGIS-capable) and a
Lightsail Container Service running Martin (the MVT tile server). The ingest
workers stay local — nothing here provisions them. See `plans/10-deployment.md`
for the full picture.

Terraform, on purpose, so the whole stack tears down with one command when
this moves to self-hosting.

## Prerequisites

- `terraform >= 1.5`, `aws` CLI (authenticated), `docker` (for the image push)
- An AWS account with billing set up. Cost: RDS `db.t4g.micro` (~$12–15/mo,
  or free-tier eligible for 12mo on a newer account) + ~$2.3/mo storage +
  Lightsail `nano` container (~$7/mo flat).

## Apply — two steps, unavoidably

Lightsail has no declarative "push this image" API — pushing into a
service's private registry is a client-side docker operation. So:

**1. Create the RDS instance and the (empty) Lightsail service:**
```bash
cd infra
terraform init
terraform apply
```
`martin_image_ref` has no default, but nothing in this first apply needs
it — Terraform only evaluates variables that resources actually reference,
and `aws_lightsail_container_service_deployment_version` is `count`-gated to
`0` while `martin_image_ref` is unset.

**2. Push the image, then apply again with the image ref:**
```bash
./scripts/push-martin-image.sh "$(terraform output -raw lightsail_service_name)"
# copy the printed :service.martin.N reference
terraform apply -var="martin_image_ref=:historical-map-martin.martin.1"
```
This creates the deployment version and brings Martin up.

Re-run the push script + apply whenever you bump `martin_source_image`'s
version (bump the label suffix Lightsail returns increments automatically —
just paste whatever it prints).

## Wire up Vercel

```bash
terraform output -raw postgres_url    # → Vercel env var POSTGRES_URL
terraform output lightsail_url        # → Vercel env var NEXT_PUBLIC_MARTIN_URL
```
Both are build-time env vars (`NEXT_PUBLIC_MARTIN_URL` is inlined into the
client bundle) — set them in the Vercel project settings, then redeploy.

## Seed it once

From the repo root, against `postgres_url` above:
```bash
POSTGRES_URL="$(terraform -chdir=infra output -raw postgres_url)" npm run migrate --workspace=services/ingest
POSTGRES_URL="$(terraform -chdir=infra output -raw postgres_url)" npm run seed:db
```
`seed:db` also applies `db/martin-functions.sql`'s `event_pins()` function,
which is what Martin auto-discovers and serves tiles from.

## Verify

```bash
curl "$(terraform output -raw lightsail_url)catalog"           # confirms Martin found event_pins
curl "$(terraform output -raw lightsail_url)event_pins/0/0/0"  # MVT bytes, not an error
```

## Teardown

```bash
terraform destroy
```
That's the entire point of this being Terraform rather than a sequence of
`aws` CLI commands — one command, no orphaned resources to hunt down across
the RDS and Lightsail consoles.

## Notes on the choices made here

- **`rds_allowed_cidr_blocks` defaults to `0.0.0.0/0`.** Vercel serverless
  functions have no fixed egress IP without paid Secure Compute, so an IP
  allowlist isn't practical. Mitigated by `sslmode=require` (enforced
  server-side via `aws_db_parameter_group.postgres`'s `rds.force_ssl=1`,
  not just the client-side connection string) and a generated 32-character
  password. This is a demo-grade tradeoff, stated plainly rather than hidden
  — revisit if this stops being a demo.
- **State is local, gitignored, and holds the DB password in plaintext**
  (`random_password.db_master`, referenced in the `postgres_url` output).
  Never commit `*.tfstate*`. Move to an encrypted S3 backend if this stops
  being a single-operator project.
- **`skip_final_snapshot = true`** on the RDS instance — intentional, so
  `terraform destroy` doesn't leave a snapshot behind to notice on a bill
  later. There's nothing in this database that isn't reproducible from
  `data/map-data.json` + re-running ingest.
