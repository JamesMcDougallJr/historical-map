# Bedrock access for semantic search (plans/23-search-semantic.md): the web
# app embeds queries at request time from Vercel, so it needs a key; CI uses
# the OIDC role in github-oidc.tf instead. Both may invoke exactly one model —
# nothing else in Bedrock, and nothing else in AWS.

locals {
  embedding_model_arn = "arn:aws:bedrock:${var.bedrock_region}::foundation-model/${var.embedding_model}"
}

data "aws_iam_policy_document" "invoke_embedding_model" {
  statement {
    sid       = "InvokeEmbeddingModelOnly"
    actions   = ["bedrock:InvokeModel"]
    resources = [local.embedding_model_arn]
  }
}

resource "aws_iam_user" "web_embeddings" {
  name = "${var.project_name}-web-embeddings"
}

resource "aws_iam_user_policy" "web_embeddings" {
  name   = "invoke-embedding-model"
  user   = aws_iam_user.web_embeddings.name
  policy = data.aws_iam_policy_document.invoke_embedding_model.json
}

# The secret lands in the (local, git-ignored) state, like the RDS password
# already does — see versions.tf. It leaves only through vercel.tf.
resource "aws_iam_access_key" "web_embeddings" {
  user = aws_iam_user.web_embeddings.name
}
