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

# ── Document storage (s3.tf) ─────────────────────────────────────────────────
# Vercel needs S3_BUCKET, S3_REGION and the *web* key pair. The local ingest
# workers need the same bucket and region with the *ingest* key pair and
# S3_ENDPOINT left empty (an empty value means real AWS S3, not MinIO).

output "documents_bucket" {
  description = "S3_BUCKET for Vercel and the ingest workers."
  value       = aws_s3_bucket.documents.bucket
}

output "documents_region" {
  description = "S3_REGION for Vercel and the ingest workers."
  value       = var.aws_region
}

output "documents_web_access_key_id" {
  description = "S3_ACCESS_KEY_ID on Vercel (read-only)."
  value       = aws_iam_access_key.documents_web.id
}

output "documents_web_secret_access_key" {
  description = "S3_SECRET_ACCESS_KEY on Vercel (read-only)."
  value       = aws_iam_access_key.documents_web.secret
  sensitive   = true
}

output "documents_ingest_access_key_id" {
  description = "S3_ACCESS_KEY_ID for the ingest workers."
  value       = aws_iam_access_key.documents_ingest.id
}

output "documents_ingest_secret_access_key" {
  description = "S3_SECRET_ACCESS_KEY for the ingest workers."
  value       = aws_iam_access_key.documents_ingest.secret
  sensitive   = true
}
