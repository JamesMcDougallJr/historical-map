locals {
  # sslmode=require: enforced server-side too via aws_db_parameter_group.postgres's
  # rds.force_ssl. Both postgres.js (lib/postgres-storage.ts) and TypeORM
  # (services/ingest/libs/database/src/data-source.ts) read this from the URL
  # directly — no application code changes needed.
  postgres_url = "postgres://${var.db_master_username}:${random_password.db_master.result}@${aws_db_instance.postgres.address}:5432/${var.db_name}?sslmode=require"
}
