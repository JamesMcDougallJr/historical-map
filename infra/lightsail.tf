# Martin (the MVT tile server), on Lightsail Container Service — a single
# stateless container that needs a stable public HTTPS URL with no load
# balancer to manage, per docker-compose.yml's `martin` service definition.
#
# AWS has no Terraform-native "push this image" resource — pushing into a
# Lightsail service's private registry is a client-side docker operation
# (scripts/push-martin-image.sh), not a declarative API call. So this is a
# genuine two-step apply: create the service first (this file's first
# resource), run the push script, then re-apply with martin_image_ref set to
# create the deployment version. See infra/README.md.

resource "aws_lightsail_container_service" "martin" {
  name        = "${var.project_name}-martin"
  power       = var.lightsail_power
  scale       = var.lightsail_scale
  is_disabled = false
}

resource "aws_lightsail_container_service_deployment_version" "martin" {
  count = var.martin_image_ref == null ? 0 : 1

  service_name = aws_lightsail_container_service.martin.name

  container {
    container_name = "martin"
    image          = var.martin_image_ref

    environment = {
      DATABASE_URL = local.postgres_url
    }

    ports = {
      "3000" = "HTTP"
    }
  }

  public_endpoint {
    container_name = "martin"
    container_port = 3000

    health_check {
      # Verify at deploy time — if Martin doesn't serve /health, switch to
      # /catalog, which it always serves once it has discovered sources.
      healthy_threshold   = 2
      unhealthy_threshold = 2
      timeout_seconds     = 5
      interval_seconds    = 10
      path                = "/health"
      success_codes       = "200"
    }
  }
}
