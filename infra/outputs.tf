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
