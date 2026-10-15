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
    vercel = {
      source  = "vercel/vercel"
      version = "~> 5.21"
    }
    # The CI role's ARN as a GitHub Actions variable (github-oidc.tf).
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

# GITHUB_TOKEN from the operator's environment (repo admin, to set Actions
# variables). The vercel provider is configured in vercel.tf.
provider "github" {
  owner = var.github_owner
}
