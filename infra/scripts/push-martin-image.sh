#!/usr/bin/env bash
# Pushes Martin's image into a Lightsail Container Service's private
# registry. Not a Terraform resource — AWS has no declarative API for this,
# it's a client-side docker operation — so it's a standalone bootstrap step.
# Run this AFTER `terraform apply` has created the service, then paste the
# printed image ref into `martin_image_ref` for the second apply.
#
#   ./scripts/push-martin-image.sh "$(terraform -chdir=.. output -raw lightsail_service_name)"
set -euo pipefail

SERVICE_NAME="${1:?usage: push-martin-image.sh <lightsail-service-name> [source-image]}"
SOURCE_IMAGE="${2:-ghcr.io/maplibre/martin:1.16.0}"

docker pull "$SOURCE_IMAGE"

aws lightsail push-container-image \
  --service-name "$SERVICE_NAME" \
  --label martin \
  --image "$SOURCE_IMAGE"

echo
echo "Copy the \":${SERVICE_NAME}.martin.N\" reference printed above into martin_image_ref, then run:"
echo "  terraform apply -var=\"martin_image_ref=:${SERVICE_NAME}.martin.N\""
