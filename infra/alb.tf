# ALB in front of the Fargate task, HTTP-only — CloudFront (cloudfront.tf) is
# what terminates HTTPS for browsers. The ALB's own listener only needs to be
# reachable from CloudFront's edge, not the whole internet.

data "aws_ec2_managed_prefix_list" "cloudfront" {
  name = "com.amazonaws.global.cloudfront.origin-facing"
}

resource "aws_security_group" "alb" {
  name        = "${var.project_name}-martin-alb"
  description = "Allow HTTP from CloudFront edge locations only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "HTTP from CloudFront"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    prefix_list_ids = [data.aws_ec2_managed_prefix_list.cloudfront.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "martin_task" {
  name        = "${var.project_name}-martin-task"
  description = "Allow Martin port from the ALB only"
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Martin from the ALB"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  # Egress needed to pull the image from ghcr.io and to reach RDS.
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "martin" {
  name               = "${var.project_name}-martin"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
}

resource "aws_lb_target_group" "martin" {
  name        = "${var.project_name}-martin"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.main.id
  target_type = "ip" # required for awsvpc-networked Fargate tasks

  health_check {
    # Verify Martin actually serves /health at deploy time — if it 404s,
    # switch to /catalog, which it always serves once it has discovered
    # sources (see infra/README.md).
    path                = "/health"
    matcher             = "200"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
    timeout             = 5
  }
}

resource "aws_lb_listener" "martin" {
  load_balancer_arn = aws_lb.martin.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.martin.arn
  }
}
