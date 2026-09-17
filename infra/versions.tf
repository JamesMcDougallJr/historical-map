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
