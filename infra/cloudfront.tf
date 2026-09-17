# HTTPS in front of the ALB, on a free *.cloudfront.net domain with an
# AWS-managed certificate — no custom domain needed. Caching is deliberately
# disabled: Martin's z/x/y tiles are filtered by from_year/to_year/source_ids
# query params (mvtQueryString() in app/map/utils/event-layers.ts), and a
# cache keyed wrong would serve one filter's tiles under another's URL.

data "aws_cloudfront_cache_policy" "caching_disabled" {
  name = "Managed-CachingDisabled"
}

data "aws_cloudfront_origin_request_policy" "all_viewer" {
  name = "Managed-AllViewer"
}

resource "aws_cloudfront_distribution" "martin" {
  enabled     = true
  price_class = "PriceClass_100" # US/Canada/Europe edges — cheapest, fine for a demo

  origin {
    domain_name = aws_lb.martin.dns_name
    origin_id   = "martin-alb"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only" # ALB listener is HTTP-only; CloudFront is what terminates HTTPS
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "martin-alb"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    cache_policy_id          = data.aws_cloudfront_cache_policy.caching_disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.all_viewer.id
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
