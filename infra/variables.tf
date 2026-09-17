variable "aws_region" {
  description = "AWS region for RDS and Lightsail."
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

variable "db_engine_version" {
  type    = string
  default = "16.4"
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

# ── Lightsail (Martin) ───────────────────────────────────────────────────────

variable "lightsail_power" {
  description = "nano is the smallest/cheapest tier (~$7/mo) — Martin is a single stateless container with light demo traffic."
  type        = string
  default     = "nano"
}

variable "lightsail_scale" {
  type    = number
  default = 1
}

variable "martin_source_image" {
  description = "Upstream image, matching docker-compose.yml's martin service. Informational — passed to scripts/push-martin-image.sh, not read by Terraform itself."
  type        = string
  default     = "ghcr.io/maplibre/martin:1.16.0"
}

variable "martin_image_ref" {
  description = <<-EOT
    The Lightsail-registry image reference (e.g. ":historical-map-martin.martin.1")
    returned by `scripts/push-martin-image.sh` after it pushes martin_source_image
    into this service's private registry. Left with no default deliberately —
    the service must exist before an image can be pushed into it, so this is
    a genuine two-step apply (see infra/README.md). Leave unset for the first
    `terraform apply` (which will create the service and RDS instance only);
    supply it for the second apply that creates the deployment version.
  EOT
  type        = string
  default     = null
}
