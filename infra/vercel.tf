# The web app's environment on Vercel, from this stack's outputs — replacing
# the README's "copy these into the Vercel dashboard" step. Only managed when
# vercel_project_id is set.
#
# Variables that already exist on the project (set by hand before this file)
# must be imported once, or the create conflicts:
#   tofu import 'vercel_project_environment_variable.app["POSTGRES_URL"]' <project_id>/<env_var_id>

locals {
  manage_vercel = var.vercel_project_id != ""

  vercel_env = {
    POSTGRES_URL           = { value = local.postgres_url, sensitive = true }
    NEXT_PUBLIC_MARTIN_URL = { value = "https://${aws_cloudfront_distribution.martin.domain_name}", sensitive = false }
    BEDROCK_REGION         = { value = var.bedrock_region, sensitive = false }
    EMBEDDING_MODEL        = { value = var.embedding_model, sensitive = false }
    AWS_ACCESS_KEY_ID      = { value = aws_iam_access_key.web_embeddings.id, sensitive = true }
    AWS_SECRET_ACCESS_KEY  = { value = aws_iam_access_key.web_embeddings.secret, sensitive = true }
  }
}

resource "vercel_project_environment_variable" "app" {
  # A literal key list, not keys(local.vercel_env): that map holds secrets,
  # and for_each refuses anything derived from a sensitive value.
  for_each = local.manage_vercel ? toset([
    "POSTGRES_URL",
    "NEXT_PUBLIC_MARTIN_URL",
    "BEDROCK_REGION",
    "EMBEDDING_MODEL",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
  ]) : toset([])

  project_id = var.vercel_project_id
  team_id    = var.vercel_team_id != "" ? var.vercel_team_id : null
  key        = each.key
  value      = local.vercel_env[each.key].value
  sensitive  = local.vercel_env[each.key].sensitive
  # NEXT_PUBLIC_* is inlined at build time, so preview builds need it too.
  target = ["production", "preview"]
}
