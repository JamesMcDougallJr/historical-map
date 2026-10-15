# Plan-time tests for the semantic-search infrastructure (plans/23). Mocked
# providers, so `tofu test` needs no AWS, Vercel or GitHub credentials and
# runs in CI — it evaluates every expression, count and for_each that
# `tofu validate` doesn't, and pins the properties that matter.

mock_provider "aws" {
  # The existing stack's lookups need plausible values to plan at all.
  mock_data "aws_availability_zones" {
    defaults = {
      names = ["us-east-1a", "us-east-1b"]
    }
  }
  mock_data "aws_rds_engine_version" {
    defaults = {
      version_actual = "16.10"
    }
  }
  mock_data "aws_iam_policy_document" {
    defaults = {
      json = "{}"
    }
  }
  mock_resource "aws_iam_openid_connect_provider" {
    defaults = {
      arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
    }
  }
  mock_resource "aws_iam_role" {
    defaults = {
      arn = "arn:aws:iam::123456789012:role/historical-map-ci-embeddings"
    }
  }
  # The provider validates ARN shapes even on mocked values.
  mock_resource "aws_lb" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/historical-map/0123456789abcdef"
    }
  }
  mock_resource "aws_lb_target_group" {
    defaults = {
      arn = "arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/historical-map/0123456789abcdef"
    }
  }
  mock_resource "aws_ecs_cluster" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:123456789012:cluster/historical-map-cluster"
    }
  }
  mock_resource "aws_ecs_task_definition" {
    defaults = {
      arn = "arn:aws:ecs:us-east-1:123456789012:task-definition/historical-map-martin:1"
    }
  }
  mock_resource "aws_cloudwatch_log_group" {
    defaults = {
      arn = "arn:aws:logs:us-east-1:123456789012:log-group:/ecs/historical-map-martin"
    }
  }
  mock_resource "aws_cloudfront_distribution" {
    defaults = {
      domain_name = "d111111abcdef8.cloudfront.net"
    }
  }
  mock_resource "aws_db_instance" {
    defaults = {
      address = "historical-map-db.example.us-east-1.rds.amazonaws.com"
    }
  }
}

mock_provider "vercel" {}
mock_provider "github" {}

run "rds_targets_the_newest_16_minor_in_the_maintenance_window" {
  command = plan

  assert {
    condition     = aws_db_instance.postgres.engine_version == "16.10"
    error_message = "engine_version must come from the aws_rds_engine_version data source"
  }
  assert {
    condition     = data.aws_rds_engine_version.postgres.version == "16" && data.aws_rds_engine_version.postgres.latest
    error_message = "the engine-version lookup must be the newest minor within major 16"
  }
  assert {
    condition     = aws_db_instance.postgres.apply_immediately == false
    error_message = "the minor upgrade must wait for the maintenance window"
  }
  assert {
    condition     = aws_db_parameter_group.postgres.family == "postgres16"
    error_message = "a minor upgrade must not change the parameter group family"
  }
}

run "bedrock_access_is_one_model_only" {
  command = plan

  assert {
    condition = (
      length(data.aws_iam_policy_document.invoke_embedding_model.statement) == 1 &&
      data.aws_iam_policy_document.invoke_embedding_model.statement[0].actions == toset(["bedrock:InvokeModel"]) &&
      data.aws_iam_policy_document.invoke_embedding_model.statement[0].resources == toset(["arn:aws:bedrock:us-west-2::foundation-model/amazon.titan-embed-text-v2:0"])
    )
    error_message = "the Bedrock policy must allow only InvokeModel on the Titan v2 model ARN"
  }
}

run "ci_role_trusts_only_this_repository" {
  command = plan

  assert {
    condition     = length(aws_iam_role.ci_embeddings) == 1 && length(aws_iam_openid_connect_provider.github) == 1
    error_message = "the OIDC provider and CI role are created by default"
  }
  assert {
    condition = anytrue([
      for c in data.aws_iam_policy_document.github_assume[0].statement[0].condition :
      c.variable == "token.actions.githubusercontent.com:sub" && toset(c.values) == toset(["repo:JamesMcDougallJr/historical-map:*"])
    ])
    error_message = "the CI role must trust only this repository's workflows"
  }
  assert {
    condition     = github_actions_variable.ci_embeddings_role_arn[0].variable_name == "AWS_EMBEDDINGS_ROLE_ARN"
    error_message = "the role ARN must reach workflows as a repository variable"
  }
}

run "an_existing_oidc_provider_is_reused" {
  command = plan

  variables {
    github_oidc_provider_arn = "arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com"
  }

  assert {
    condition     = length(aws_iam_openid_connect_provider.github) == 0
    error_message = "with an existing provider ARN, none is created (an account allows one)"
  }
}

run "the_budget_is_off_without_an_email" {
  command = plan

  assert {
    condition     = length(aws_budgets_budget.bedrock) == 0
    error_message = "without alert_email, no budget is created"
  }
}

run "vercel_gets_the_bedrock_settings_beside_the_existing_env" {
  command = plan

  assert {
    condition = alltrue([
      for k in ["POSTGRES_URL", "S3_BUCKET", "S3_REGION", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY",
      "BEDROCK_REGION", "EMBEDDING_MODEL", "BEDROCK_ACCESS_KEY_ID", "BEDROCK_SECRET_ACCESS_KEY"] :
      contains(keys(vercel_project_environment_variable.this), k)
    ])
    error_message = "the existing env and the Bedrock settings must all be managed"
  }
  assert {
    condition = length([
      for k in keys(vercel_project_environment_variable.this) : k if startswith(k, "AWS_")
    ]) == 0
    error_message = "Vercel reserves AWS_* names; Bedrock credentials must use BEDROCK_*"
  }
  assert {
    condition = (
      vercel_project_environment_variable.this["BEDROCK_SECRET_ACCESS_KEY"].sensitive &&
      !vercel_project_environment_variable.this["BEDROCK_REGION"].sensitive
    )
    error_message = "the Bedrock secret must be sensitive on Vercel"
  }
  assert {
    condition     = vercel_project_environment_variable.this["EMBEDDING_MODEL"].value == "amazon.titan-embed-text-v2:0"
    error_message = "the embedding model must be the one the IAM policy allows"
  }
  assert {
    condition     = toset(vercel_project_environment_variable.this["BEDROCK_ACCESS_KEY_ID"].target) == toset(["production"])
    error_message = "production only, like the rest: previews have no database"
  }
}

run "the_budget_watches_bedrock_spend" {
  command = plan

  variables {
    alert_email = "alerts@example.com"
  }

  assert {
    condition = (
      length(aws_budgets_budget.bedrock) == 1 &&
      toset(one([for f in aws_budgets_budget.bedrock[0].cost_filter : f.values if f.name == "Service"])) == toset(["Amazon Bedrock"])
    )
    error_message = "the budget must be filtered to Amazon Bedrock"
  }
  assert {
    condition     = length(aws_budgets_budget.bedrock[0].notification) == 2
    error_message = "the budget alerts at 80% actual and 100% forecast"
  }
}
