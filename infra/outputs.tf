output "postgres_url" {
  description = "Set this as POSTGRES_URL on Vercel and for local ingest workers."
  value       = local.postgres_url
  sensitive   = true
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.address
}

output "martin_url" {
  description = "Set this as NEXT_PUBLIC_MARTIN_URL on Vercel — a CloudFront HTTPS endpoint in front of the ALB/Fargate task."
  value       = "https://${aws_cloudfront_distribution.martin.domain_name}"
}

output "alb_dns_name" {
  description = "For debugging the ALB/Fargate task directly (HTTP only, not what Vercel should point at)."
  value       = aws_lb.martin.dns_name
}

output "rds_engine_version" {
  description = "The RDS PostgreSQL version this stack targets (newest 16.x). pgvector 0.8 needs ≥ 16.5."
  value       = data.aws_rds_engine_version.postgres.version_actual
}

output "ci_embeddings_role_arn" {
  description = "Role GitHub Actions assumes for Bedrock (also published as the AWS_EMBEDDINGS_ROLE_ARN repository variable)."
  value       = local.manage_github_oidc ? aws_iam_role.ci_embeddings[0].arn : null
}
