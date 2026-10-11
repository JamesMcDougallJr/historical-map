# CI's Bedrock access, without a long-lived secret: GitHub Actions exchanges
# its OIDC token for this role's temporary credentials. Used by the
# bedrock-live workflow (plans/23-search-semantic.md) for the live embedding
# check and for re-recording e2e-real/fixtures/search-vectors.json.

locals {
  manage_github_oidc = var.github_repository != ""
  github_oidc_provider_arn = var.github_oidc_provider_arn != "" ? var.github_oidc_provider_arn : (
    local.manage_github_oidc ? aws_iam_openid_connect_provider.github[0].arn : ""
  )
}

resource "aws_iam_openid_connect_provider" "github" {
  count = local.manage_github_oidc && var.github_oidc_provider_arn == "" ? 1 : 0

  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS validates GitHub's OIDC certificate chain itself; the thumbprints are
  # still required by the API, and these are GitHub's published ones.
  thumbprint_list = [
    "6938fd4d98bab03faadb97b34396831e3780aea1",
    "1c58a3a8518e8759bf075b76b750d4f2df264fcd",
  ]
}

data "aws_iam_policy_document" "github_assume" {
  count = local.manage_github_oidc ? 1 : 0

  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_provider_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    # This repository only — any branch, PR or schedule in it, nothing else.
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["repo:${var.github_owner}/${var.github_repository}:*"]
    }
  }
}

resource "aws_iam_role" "ci_embeddings" {
  count = local.manage_github_oidc ? 1 : 0

  name                 = "${var.project_name}-ci-embeddings"
  assume_role_policy   = data.aws_iam_policy_document.github_assume[0].json
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "ci_embeddings" {
  count = local.manage_github_oidc ? 1 : 0

  name   = "invoke-embedding-model"
  role   = aws_iam_role.ci_embeddings[0].id
  policy = data.aws_iam_policy_document.invoke_embedding_model.json
}

# Workflows read the role ARN from a repository variable, so the account id
# never has to be pasted into a workflow file.
resource "github_actions_variable" "ci_embeddings_role_arn" {
  count = local.manage_github_oidc ? 1 : 0

  repository    = var.github_repository
  variable_name = "AWS_EMBEDDINGS_ROLE_ARN"
  value         = aws_iam_role.ci_embeddings[0].arn
}

resource "github_actions_variable" "bedrock_region" {
  count = local.manage_github_oidc ? 1 : 0

  repository    = var.github_repository
  variable_name = "BEDROCK_REGION"
  value         = var.bedrock_region
}
