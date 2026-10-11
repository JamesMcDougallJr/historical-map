variable "aws_region" {
  description = "AWS region for RDS, ECS/Fargate, and the ALB. CloudFront is global regardless."
  type        = string
  default     = "us-east-1"
}

variable "project_name" {
  description = "Prefix for resource names, so this stack is identifiable and easy to find/destroy."
  type        = string
  default     = "historical-map"
}

# ── RDS ──────────────────────────────────────────────────────────────────────

variable "db_name" {
  description = "Database name. Must match what lib/postgres-storage.ts and services/ingest connect to."
  type        = string
  default     = "historicalmap"
}

variable "db_master_username" {
  type    = string
  default = "postgres"
}

variable "db_instance_class" {
  description = "Smallest Graviton class — this is a demo, not a production workload."
  type        = string
  default     = "db.t4g.micro"
}

variable "db_allocated_storage" {
  type    = number
  default = 20
}

variable "db_engine_major_version" {
  description = "RDS PostgreSQL major version. rds.tf resolves the newest minor within it (≥ 16.5 is what pgvector 0.8 needs)."
  type        = string
  default     = "16"
}

variable "rds_allowed_cidr_blocks" {
  description = <<-EOT
    CIDR blocks allowed to reach RDS on 5432. Defaults to the whole internet
    because Vercel serverless functions have no fixed egress IP on a
    Hobby/Pro plan (fixed IPs are a paid "Secure Compute" feature) — this is
    a documented demo-grade tradeoff, mitigated by sslmode=require and a
    generated password, not an oversight. Narrow this if Vercel static IPs
    are ever purchased, or if RDS access is only ever needed from known IPs.
  EOT
  type        = list(string)
  default     = ["0.0.0.0/0"]
}

# ── Martin (ECS Fargate + ALB + CloudFront) ─────────────────────────────────
#
# Not Lightsail Container Service: this account's Container Service quota is
# 0 (confirmed empty across every Lightsail region, yet AWS still rejects
# creating the first one as "exceeding your maximum limit" — a quota-increase
# request is required and isn't instant). Fargate needs no such request.
#
# A plain ALB can't get a browser-trusted HTTPS certificate without owning a
# custom domain (ACM won't issue certs for the ALB's own *.elb.amazonaws.com
# name) — and Vercel serves the map over HTTPS, so an HTTP-only tile endpoint
# is blocked outright as mixed content, not just insecure. CloudFront sits in
# front of the ALB purely to get a free HTTPS endpoint on a *.cloudfront.net
# domain with an AWS-managed certificate, no domain purchase required.

variable "martin_source_image" {
  description = "Matches docker-compose.yml's martin service. Fargate pulls this directly — unlike Lightsail, no local docker pull/push step is needed."
  type        = string
  default     = "ghcr.io/maplibre/martin:1.16.0"
}

variable "martin_cpu" {
  description = "Fargate task vCPU units (256 = 0.25 vCPU, the smallest size) — Martin is a single stateless process with light demo traffic."
  type        = string
  default     = "256"
}

variable "martin_memory" {
  description = "Fargate task memory in MiB. 512 is the minimum paired with 256 CPU units."
  type        = string
  default     = "512"
}

# ── Semantic search (plans/23-search-semantic.md) ───────────────────────────

variable "bedrock_region" {
  description = "Region for Bedrock embeddings — Titan Embed v2 was verified live in us-west-2 (plan 12), separate from aws_region."
  type        = string
  default     = "us-west-2"
}

variable "embedding_model" {
  description = "The only Bedrock model the web app and CI may invoke."
  type        = string
  default     = "amazon.titan-embed-text-v2:0"
}

variable "bedrock_monthly_budget_usd" {
  description = "Monthly Bedrock spend that triggers the budget alert. Embeddings are ~10–30 tokens per query, so any real spend here means abuse."
  type        = number
  default     = 10
}

variable "alert_email" {
  description = "Where the Bedrock budget alert is emailed. Empty skips the budget."
  type        = string
  default     = ""
}

variable "vercel_project_id" {
  description = "Vercel project to receive env vars (POSTGRES_URL, NEXT_PUBLIC_MARTIN_URL, Bedrock). Empty skips Vercel management."
  type        = string
  default     = ""
}

variable "vercel_team_id" {
  description = "Vercel team owning the project, if not a personal account."
  type        = string
  default     = ""
}

variable "github_owner" {
  description = "GitHub owner of the repository CI runs in."
  type        = string
  default     = "JamesMcDougallJr"
}

variable "github_repository" {
  description = "Repository whose workflows may assume the Bedrock CI role. Empty skips the OIDC role."
  type        = string
  default     = "historical-map"
}

variable "github_oidc_provider_arn" {
  description = "An existing token.actions.githubusercontent.com OIDC provider in this account (there can be only one). Empty creates it."
  type        = string
  default     = ""
}
