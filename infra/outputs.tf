output "postgres_url" {
  description = "Set this as POSTGRES_URL on Vercel and for local ingest workers."
  value       = local.postgres_url
  sensitive   = true
}

output "rds_endpoint" {
  value = aws_db_instance.postgres.address
}

output "lightsail_service_name" {
  description = "Pass to scripts/push-martin-image.sh."
  value       = aws_lightsail_container_service.martin.name
}

output "lightsail_url" {
  description = "Set this as NEXT_PUBLIC_MARTIN_URL on Vercel once the deployment version exists (second apply)."
  value       = try(aws_lightsail_container_service.martin.url, null)
}
