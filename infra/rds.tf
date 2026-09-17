# RDS for PostgreSQL — the one Postgres both Vercel and the local ingest
# workers point POSTGRES_URL at. Runs in the minimal VPC from networking.tf.

resource "random_password" "db_master" {
  length  = 32
  special = false # some special chars break libpq connection-string parsing; alnum is plenty of entropy at 32 chars
}

resource "aws_db_subnet_group" "main" {
  name       = "${var.project_name}-db"
  subnet_ids = aws_subnet.public[*].id
}

resource "aws_security_group" "rds" {
  name        = "${var.project_name}-rds"
  description = "Allow Postgres from Vercel + local ingest workers"
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "Postgres"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = var.rds_allowed_cidr_blocks
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

# rds.force_ssl can't be set on the default parameter group, so a dedicated
# one exists purely to enforce sslmode=require server-side, on top of the
# client-side ?sslmode=require in the connection string.
resource "aws_db_parameter_group" "postgres" {
  name   = "${var.project_name}-pg16"
  family = "postgres16"

  parameter {
    name         = "rds.force_ssl"
    value        = "1"
    apply_method = "pending-reboot"
  }
}

resource "aws_db_instance" "postgres" {
  identifier     = "${var.project_name}-db"
  engine         = "postgres"
  engine_version = var.db_engine_version

  instance_class    = var.db_instance_class
  allocated_storage = var.db_allocated_storage
  storage_type      = "gp3"

  db_name  = var.db_name
  username = var.db_master_username
  password = random_password.db_master.result

  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  parameter_group_name   = aws_db_parameter_group.postgres.name
  publicly_accessible    = true

  multi_az                = false # demo, not HA
  backup_retention_period = 1
  skip_final_snapshot     = true # easy teardown over a safety net this project doesn't need

  # postgis needs CREATE EXTENSION at connect time (lib/postgres-storage.ts's
  # ensureSchema()); RDS Postgres allows it out of the box, no extra setting.
}
