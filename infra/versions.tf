terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    # Vercel env vars (vercel.tf) and the CI role's ARN as a GitHub Actions
    # variable (github-oidc.tf), so nothing is pasted into a dashboard.
    vercel = {
      source  = "vercel/vercel"
      version = "~> 3.0"
    }
    github = {
      source  = "integrations/github"
      version = "~> 6.0"
    }
  }

  # Local state on purpose: this is a single-operator demo stack, and a local
  # backend means `terraform destroy` needs nothing but this directory and
  # your AWS credentials. It DOES mean terraform.tfstate holds the RDS master
  # password in plaintext (see the sensitive output below) — .gitignore
  # excludes it, and it must never be committed. Move to an encrypted S3
  # backend if this ever stops being a solo demo project.
}

provider "aws" {
  region = var.aws_region
}

# Credentials from the operator's environment, never from variables or state:
# VERCEL_API_TOKEN for vercel, GITHUB_TOKEN for github. Both providers only
# manage resources when their project/repository variables are set (see
# vercel.tf, github-oidc.tf), so the stack still plans without them.
provider "vercel" {
  team = var.vercel_team_id != "" ? var.vercel_team_id : null
}

provider "github" {
  owner = var.github_owner
}
