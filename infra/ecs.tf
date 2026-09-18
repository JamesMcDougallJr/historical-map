# Martin itself, as a single Fargate task. No image push step, unlike
# Lightsail — Fargate pulls ghcr.io/maplibre/martin directly, since it's a
# public image and the task has internet access via its public IP.

resource "aws_ecs_cluster" "main" {
  name = "${var.project_name}-cluster"
}

resource "aws_cloudwatch_log_group" "martin" {
  name              = "/ecs/${var.project_name}-martin"
  retention_in_days = 7 # short — this is a demo, not something to audit later
}

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_execution" {
  name               = "${var.project_name}-martin-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_execution" {
  role       = aws_iam_role.ecs_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_ecs_task_definition" "martin" {
  family                   = "${var.project_name}-martin"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = var.martin_cpu
  memory                   = var.martin_memory
  execution_role_arn       = aws_iam_role.ecs_execution.arn

  container_definitions = jsonencode([
    {
      name      = "martin"
      image     = var.martin_source_image
      essential = true
      portMappings = [
        { containerPort = 3000, protocol = "tcp" }
      ]
      environment = [
        { name = "DATABASE_URL", value = local.postgres_url }
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          "awslogs-group"         = aws_cloudwatch_log_group.martin.name
          "awslogs-region"        = var.aws_region
          "awslogs-stream-prefix" = "martin"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "martin" {
  name            = "${var.project_name}-martin"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.martin.arn
  desired_count   = 1
  launch_type     = "FARGATE"

  network_configuration {
    subnets          = aws_subnet.public[*].id
    security_groups  = [aws_security_group.martin_task.id]
    assign_public_ip = true # no NAT gateway — this is the cost tradeoff that keeps it out of the stack
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.martin.arn
    container_name   = "martin"
    container_port   = 3000
  }

  depends_on = [aws_lb_listener.martin]
}
