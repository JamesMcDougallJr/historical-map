# The Vercel project's environment, defined from this stack's own outputs, so
# the values Vercel needs can never drift from the resources that produce them
# — rotating the documents key or recreating RDS updates Vercel in the same
# apply.
#
# Authenticates with VERCEL_API_TOKEN (create one at vercel.com/account/tokens)
# exported alongside your AWS credentials when running tofu.
#
# Changing an environment variable does not redeploy: the running deployment
# keeps the values it was built with until the next deploy (a push to main).
#
# Only what this stack owns is managed here. Variables set by hand in the
# Vercel dashboard (MAP_API_KEY, NEXT_PUBLIC_*, …) are left alone — the
# provider manages individual variables, not the project's whole environment.

variable "vercel_team_id" {
  description = "Team that owns the Vercel project."
  type        = string
  default     = "team_NIO34Hw7V4fDKirTi6mBNoSp"
}

variable "vercel_project_id" {
  description = "The historical-map Vercel project (historical-map-omega.vercel.app)."
  type        = string
  default     = "prj_FJUPWvLcqnxLyrXOZjEs3DMJIbgV"
}

variable "vercel_env_targets" {
  # Production only, matching how POSTGRES_URL was set by hand. PR previews
  # get no database and run on the bundled demo data — giving them production
  # Postgres would let any preview write to it, since /api/data allows writes
  # whenever MAP_API_KEY is unset.
  description = "Deployments that read these values."
  type        = list(string)
  default     = ["production"]
}

# No `team` here on purpose: setting it makes the provider read the team on
# startup, which a personal (Hobby) account's team scope refuses with
# team_unauthorized. Each resource passes team_id instead.
provider "vercel" {}

locals {
  # name → { value, sensitive }. Sensitive values can't be read back from
  # Vercel's dashboard or API once written.
  vercel_env = {
    POSTGRES_URL         = { value = local.postgres_url, sensitive = true }
    S3_BUCKET            = { value = aws_s3_bucket.documents.bucket, sensitive = false }
    S3_REGION            = { value = var.aws_region, sensitive = false }
    S3_ACCESS_KEY_ID     = { value = aws_iam_access_key.documents_web.id, sensitive = false }
    S3_SECRET_ACCESS_KEY = { value = aws_iam_access_key.documents_web.secret, sensitive = true }
  }
}

resource "vercel_project_environment_variable" "this" {
  for_each = local.vercel_env

  team_id    = var.vercel_team_id
  project_id = var.vercel_project_id
  key        = each.key
  value      = each.value.value
  target     = var.vercel_env_targets
  sensitive  = each.value.sensitive
  comment    = "Managed by infra/ (OpenTofu) — edit there, not in the dashboard."
}
